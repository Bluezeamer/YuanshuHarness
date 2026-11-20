import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import {
  CanvasError,
  CanvasService,
  canvasHostId,
  canvasHostName,
} from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-svc-"));
  dirs.push(d);
  return d;
};

const service = () =>
  new CanvasService({
    env: (id) => (id === "local" ? new LocalEnv() : null),
    commitDelayMs: 10,
  });

describe("CanvasService：主机名", () => {
  test("hostId 优先用接线给的解析（带着画布所在的环境）；没给就只认存在的环境 id", () => {
    const seen: string[] = [];
    const wired = new CanvasService({
      env: () => null,
      hostId: (t, home) => {
        seen.push(`${t}@${home}`);
        return t === "dev-01" ? "h1" : null;
      },
    });
    expect(wired.hostId("dev-01", "local")).toBe("h1");
    expect(wired.hostId("nope", "local")).toBeNull();
    expect(seen).toEqual(["dev-01@local", "nope@local"]);
    const bare = new CanvasService({
      env: (id) => (id === "local" ? new LocalEnv() : null),
    });
    expect(bare.hostId("local", "local")).toBe("local");
    expect(bare.hostId("dev-01", "local")).toBeNull();
  });
});

describe("CanvasService", () => {
  test("close 先把还在去抖的提交冲掉：退出时没有提交悬在半空，也不会丢来源", async () => {
    const dir = tmp();
    const svc = new CanvasService({
      env: (id) => (id === "local" ? new LocalEnv() : null),
      commitDelayMs: 60_000,
    });
    await svc.repo("local", dir).createBoard("x");
    await svc.close();
    const log = execFileSync(
      "git",
      ["-C", path.join(dir, ".canvas"), "log", "--format=%s"],
      { encoding: "utf8" },
    );
    expect(log).toContain("x.canvas");
  });

  test("同一对 (envId, 目录) 复用同一个仓库实例", () => {
    const svc = service();
    const dir = tmp();
    const a = svc.repo("local", dir);
    expect(svc.repo("local", dir)).toBe(a);
    expect(svc.repo("local", tmp())).not.toBe(a);
  });

  test("环境不可用抛 env_unavailable（502）", () => {
    const err = (() => {
      try {
        service().repo("nope", "/tmp");
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(CanvasError);
    expect(err).toMatchObject({ code: "env_unavailable", status: 502 });
  });

  test("目录只做形状校验：相对路径与空串都是 invalid_path，存在性不管", () => {
    const svc = service();
    for (const bad of ["", "relative/dir", "/bad\0path"])
      expect(() => svc.repo("local", bad)).toThrowError(CanvasError);
    expect(svc.repo("local", "/definitely/not/here").root).toBe(
      "/definitely/not/here/.canvas",
    );
  });
});

describe("CanvasService：远程环境的本地优先", () => {
  // 借本机文件系统冒充一台 ssh 主机
  const fakeSsh = (): ExecEnv =>
    Object.assign(Object.create(new LocalEnv()), {
      kind: "ssh",
      id: "h1",
    }) as ExecEnv;

  test("画布落在本机副本，settle 后才推到远端；本机环境不做副本；重建服务后接着认", async () => {
    const base = tmp();
    const project = path.join(base, "proj");
    mkdirSync(project);
    const ssh = fakeSsh();
    const make = () =>
      new CanvasService({
        env: (id) =>
          id === "h1" ? ssh : id === "local" ? new LocalEnv() : null,
        commitDelayMs: 10,
        replicaDir: path.join(base, "replica"),
      });
    const svc = make();

    const repo = svc.repo("h1", project);
    expect(svc.adopted("h1", project)).toBe(false);
    await repo.createBoard("x");
    expect(svc.adopted("h1", project)).toBe(true);
    expect(existsSync(path.join(project, ".canvas"))).toBe(false);

    await svc.settle("h1", project, 3000);
    expect(existsSync(path.join(project, ".canvas", "x.canvas"))).toBe(true);
    expect(svc.mirrorStatus("h1", project)).toMatchObject({ state: "synced" });
    expect(svc.mirrorStatus("local", project)).toBeNull();
    expect(svc.envFor("local", project)).not.toBe(svc.envFor("h1", project));
    await svc.close();

    const again = make();
    expect(again.adopted("h1", project)).toBe(true);
    await again.close();
  });

  test("同一个目录的不同写法（结尾斜杠、a/../b）落在同一个实例与同一份副本上", async () => {
    const base = tmp();
    const project = path.join(base, "proj");
    mkdirSync(project);
    const svc = new CanvasService({
      env: (id) => (id === "h1" ? fakeSsh() : null),
      replicaDir: path.join(base, "replica"),
    });
    const a = svc.repo("h1", project);
    expect(svc.repo("h1", `${project}/`)).toBe(a);
    expect(svc.repo("h1", path.join(base, "x", "..", "proj"))).toBe(a);
    await a.createBoard("x");
    expect(svc.adopted("h1", `${project}/`)).toBe(true);
    await svc.close();
  });
});

describe("画布里的主机名：相对画布所在的环境", () => {
  const envs = () => [
    { id: "local", name: "本机" },
    { id: "h1", name: "dev1" },
    // 名字写不进地址：退回环境 id
    { id: "h2", name: "weird name" },
  ];

  test("画布环境叫 local，Server 本机在不是它时叫 server，其余是连接名；写不进地址的退回 id", () => {
    expect(canvasHostName(envs, "h1", "h1")).toBe("local");
    expect(canvasHostName(envs, "local", "h1")).toBe("server");
    expect(canvasHostName(envs, "h2", "h1")).toBe("h2");
    // 画布就在本机：本机叫 local，另一台是连接名
    expect(canvasHostName(envs, "local", "local")).toBe("local");
    expect(canvasHostName(envs, "h1", "local")).toBe("dev1");
  });

  test("解析回环境 id：连接名、local、server、环境 id 都认，找不到与附件区是 null", () => {
    expect(canvasHostId(envs, "local", "h1")).toBe("h1");
    expect(canvasHostId(envs, "LOCAL", "h1")).toBe("h1");
    expect(canvasHostId(envs, "server", "h1")).toBe("local");
    // 画布环境自己叫 local，它的连接名不再是这个名字（与地址簿一致）
    expect(canvasHostId(envs, "dev1", "h1")).toBeNull();
    expect(canvasHostId(envs, "dev1", "local")).toBe("h1");
    expect(canvasHostId(envs, "h1", "h1")).toBe("h1");
    expect(canvasHostId(envs, "h2", "h1")).toBe("h2");
    expect(canvasHostId(envs, "nope", "h1")).toBeNull();
    // 画布就在本机：server 与 local 都是本机
    expect(canvasHostId(envs, "server", "local")).toBe("local");
    expect(canvasHostId(envs, "local", "local")).toBe("local");
  });
});

describe("画布的主机名跟着画布所在的环境走", () => {
  // 借本机文件系统冒充一台 ssh 主机
  const fakeSsh = (): ExecEnv =>
    Object.assign(Object.create(new LocalEnv()), {
      kind: "ssh",
      id: "h1",
    }) as ExecEnv;

  test("非主目录的画布：index.md 里 local 是它自己的主机，Server 本机叫 server", async () => {
    const project = tmp();
    const ssh = fakeSsh();
    const envs = () => [
      { id: "local", name: "本机" },
      { id: "h1", name: "dev1" },
    ];
    const svc = new CanvasService({
      env: (id) => (id === "h1" ? ssh : null),
      commitDelayMs: 10,
      hostName: (envId, home) => canvasHostName(envs, envId, home),
    });
    const repo = svc.repo("h1", project);
    await repo.createBoard("b");
    const { doc, baseline } = await repo.readBoard("b");
    doc.nodes.push(
      {
        id: "n1",
        type: "file",
        file: "/srv/a.md",
        host: "h1",
        x: 0,
        y: 0,
        width: 260,
        height: 160,
      },
      {
        id: "n2",
        type: "file",
        file: "/home/me/b.md",
        host: "local",
        x: 300,
        y: 0,
        width: 260,
        height: 160,
      },
    );
    await repo.saveBoard("b", doc, baseline);
    await repo.settle();
    const index = readFileSync(
      path.join(project, ".canvas", "index.md"),
      "utf8",
    );
    // 画布自己的主机叫 local，Server 本机（另一台）叫 server
    expect(index).toContain("ref  local:/srv/a.md");
    expect(index).toContain("ref  server:/home/me/b.md");
    await svc.close();
  });
});
