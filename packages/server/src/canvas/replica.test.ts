// 副本环境 + 镜像 + 仓库连起来：画布操作只在本机，远端靠后台推。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { CanvasMirror } from "./mirror.js";
import { ReplicaEnv } from "./replica-env.js";
import { CanvasRepo } from "./repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 远端：记下调用，可以断线 */
function remoteOf(env: LocalEnv) {
  const ctl = { down: false, calls: [] as string[] };
  const proxy = new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        ctl.calls.push(String(prop));
        if (ctl.down) return Promise.reject(new Error("connection lost"));
        return value.apply(target, args);
      };
    },
  }) as ExecEnv;
  return { env: proxy, ctl };
}

function setup(debounceMs = 10) {
  const base = mkdtempSync(path.join(tmpdir(), "yuanshu-replica-"));
  dirs.push(base);
  const project = path.join(base, "remote", "proj");
  mkdirSync(project, { recursive: true });
  const remoteRoot = path.join(project, ".canvas");
  const localRoot = path.join(base, "replica", ".canvas");
  const remote = remoteOf(new LocalEnv());
  const mirror = new CanvasMirror({
    remote: remote.env,
    remoteRoot,
    local: new LocalEnv(),
    localRoot,
    metaFile: path.join(base, "replica", "mirror.json"),
    debounceMs,
  });
  const env = new ReplicaEnv({
    remote: remote.env,
    local: new LocalEnv(),
    remoteRoot,
    localRoot,
    mirror,
  });
  const repo = new CanvasRepo(env, project, {
    commitDelayMs: 20,
    mirrored: true,
  });
  return { project, remoteRoot, localRoot, remote, mirror, env, repo };
}

describe("画布在副本上跑", () => {
  test("新建画布与卡片：只落本机，settle 之后远端才有；git 历史在本机，远端不建 .git", async () => {
    const t = setup(60_000);
    await t.mirror.ready();

    const board = await t.repo.createBoard("想法");
    const card = await t.repo.createCard(board, { name: "a", text: "hello" });
    await t.repo.settle();
    expect((await t.repo.history()).length).toBeGreaterThan(0);
    expect(existsSync(path.join(t.localRoot, ".git"))).toBe(true);
    expect(readFileSync(path.join(t.localRoot, card.path), "utf8")).toBe(
      "hello",
    );
    expect(existsSync(path.join(t.remoteRoot, card.path))).toBe(false);

    expect(await t.mirror.settle(3000)).toBe(true);
    expect(readFileSync(path.join(t.remoteRoot, card.path), "utf8")).toBe(
      "hello",
    );
    expect(existsSync(path.join(t.remoteRoot, "index.md"))).toBe(true);
    expect(existsSync(path.join(t.remoteRoot, ".git"))).toBe(false);
  });

  test("远端断线：读写、历史照常，状态离线；恢复后推齐", async () => {
    const t = setup();
    await t.mirror.ready();
    t.remote.ctl.down = true;

    const board = await t.repo.createBoard("离线板");
    await t.repo.createCard(board, { name: "n", text: "offline edit" });
    expect((await t.repo.readBoard(board)).doc.nodes).toHaveLength(1);
    expect(await t.repo.listBoards()).toHaveLength(1);
    expect(await t.mirror.settle(1000)).toBe(false);
    expect(t.mirror.status().state).toBe("offline");

    t.remote.ctl.down = false;
    expect(await t.mirror.settle(3000)).toBe(true);
    expect(
      readFileSync(path.join(t.remoteRoot, "离线板.cards", "n.md"), "utf8"),
    ).toBe("offline edit");
  });

  test("远端已有 .canvas（含旧 .git）：接入后读得到，之后读写不碰远端，旧 .git 原样", async () => {
    const t = setup(60_000);
    mkdirSync(t.remoteRoot, { recursive: true });
    writeFileSync(
      path.join(t.remoteRoot, "旧.canvas"),
      JSON.stringify({ nodes: [], edges: [] }),
    );
    mkdirSync(path.join(t.remoteRoot, ".git"));
    writeFileSync(path.join(t.remoteRoot, ".git", "HEAD"), "x");

    expect((await t.repo.listBoards()).map((b) => b.name)).toEqual(["旧"]);
    t.remote.ctl.calls.length = 0;
    await t.repo.createCard("旧", { name: "c", text: "t" });
    await t.repo.readBoard("旧");
    expect(t.remote.ctl.calls).toEqual([]);
    expect(readFileSync(path.join(t.remoteRoot, ".git", "HEAD"), "utf8")).toBe(
      "x",
    );
  });

  test("改名画布：远端也改名，卡片不重传", async () => {
    const t = setup();
    const board = await t.repo.createBoard("甲");
    await t.repo.createCard(board, { name: "c", text: "body" });
    expect(await t.mirror.settle(3000)).toBe(true);
    const uploads = () =>
      t.remote.ctl.calls.filter((c) => c === "writeStream").length;
    const before = uploads();

    await t.repo.renameBoard("甲", "乙");
    expect(await t.mirror.settle(3000)).toBe(true);
    expect(existsSync(path.join(t.remoteRoot, "甲.canvas"))).toBe(false);
    expect(
      readFileSync(path.join(t.remoteRoot, "乙.cards", "c.md"), "utf8"),
    ).toBe("body");
    // 画布文件本身内容变了（要重传）、index.md 也变了；卡片只改名
    expect(uploads() - before).toBeLessThanOrEqual(2);
  });
});

describe("路径分流", () => {
  test(".canvas 之外走远端，之内走本机副本；跨边界改名拒绝", async () => {
    const t = setup(60_000);
    mkdirSync(path.join(t.project, "src"));
    writeFileSync(path.join(t.project, "src", "x.ts"), "code");
    await t.mirror.ready();
    t.remote.ctl.calls.length = 0;

    expect((await t.env.stat(path.join(t.project, "src", "x.ts")))?.size).toBe(
      4,
    );
    expect(t.remote.ctl.calls).toEqual(["stat"]);

    await t.env.mkdirp(t.remoteRoot);
    await t.env.writeFile(path.join(t.remoteRoot, "a.md"), "in replica");
    expect(readFileSync(path.join(t.localRoot, "a.md"), "utf8")).toBe(
      "in replica",
    );
    expect(existsSync(path.join(t.remoteRoot, "a.md"))).toBe(false);
    expect(await t.env.realpath(path.join(t.remoteRoot, "a.md"))).toBe(
      path.join(t.remoteRoot, "a.md"),
    );
    await expect(
      t.env.rename(
        path.join(t.remoteRoot, "a.md"),
        path.join(t.project, "a.md"),
      ),
    ).rejects.toThrow("内外之间");
    t.mirror.close();
  });
});
