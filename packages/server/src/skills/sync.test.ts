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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import { LocalEnv } from "../env/local.js";
import { SshEnv } from "../env/ssh.js";
import type { ExecEnv } from "../env/types.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import type { SkillMeta, SkillScope } from "../store/skills.js";
import { hashFiles, SKILL_FILE, type SkillFile } from "./spec.js";
import { type SyncInput, syncSkills } from "./sync.js";

const md = (name: string, body = "正文") =>
  `---\nname: ${name}\ndescription: 测试 ${name}\n---\n\n${body}\n`;

const input = (
  name: string,
  extra: Record<string, string> = {},
  body?: string,
  scope: SkillScope = "project",
): SyncInput => {
  const files: SkillFile[] = [
    { path: SKILL_FILE, content: Buffer.from(md(name, body)) },
    ...Object.entries(extra).map(([p, c]) => ({
      path: p,
      content: Buffer.from(c),
    })),
  ];
  const meta: SkillMeta = {
    name,
    description: `测试 ${name}`,
    scope,
    source: "local",
    hash: hashFiles(files),
    createdAt: "",
    updatedAt: "",
  };
  return { meta, files };
};

// 本机与 ssh 两个实现的同步行为必须一致；ssh 的 sshd 与测试同机，所以能直接用 fs 校验落盘。
function behaviors(make: () => Promise<ExecEnv>) {
  let dir: string;
  let ws: string;
  let env: ExecEnv;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-sync-"));
    ws = path.join(dir, "proj");
    mkdirSync(ws);
    env = await make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const at = (name: string, ...rest: string[]) =>
    path.join(ws, ".agents/skills/yuanshu", name, ...rest);

  test("首次新增、再次同步幂等", async () => {
    const i = input("alpha", { "scripts/run.sh": "echo hi\n" });
    const [first] = await syncSkills(env, ws, [i]);
    expect(first).toMatchObject({ name: "alpha", status: "added" });
    expect(first?.dir).toBe(at("alpha"));
    expect(readFileSync(at("alpha", "scripts/run.sh"), "utf8")).toBe(
      "echo hi\n",
    );
    const [again] = await syncSkills(env, ws, [i]);
    expect(again).toMatchObject({ status: "unchanged", dir: at("alpha") });
  });

  test("库更新后覆盖，库里删掉的文件也从环境清掉", async () => {
    await syncSkills(env, ws, [input("beta", { "old.txt": "x" })]);
    const [r] = await syncSkills(env, ws, [
      input("beta", { "new.txt": "y" }, "改过"),
    ]);
    expect(r?.status).toBe("updated");
    expect(existsSync(at("beta", "old.txt"))).toBe(false);
    expect(readFileSync(at("beta", "new.txt"), "utf8")).toBe("y");
    expect(readFileSync(at("beta", SKILL_FILE), "utf8")).toContain("改过");
  });

  test("环境里手写的同名 skill 内容不同：不覆盖并报告", async () => {
    const hand = path.join(ws, ".pi/skills/gamma");
    mkdirSync(hand, { recursive: true });
    writeFileSync(path.join(hand, SKILL_FILE), md("gamma", "我手写的"));
    const [r] = await syncSkills(env, ws, [input("gamma")]);
    expect(r).toMatchObject({ status: "conflict", dir: null });
    expect(r?.message).toContain(hand);
    expect(readFileSync(path.join(hand, SKILL_FILE), "utf8")).toContain(
      "我手写的",
    );
    expect(existsSync(at("gamma"))).toBe(false);
  });

  test("环境里已有内容一致的同名 skill：直接沿用，不重复写", async () => {
    const i = input("delta");
    const hand = path.join(ws, ".agents/skills/delta");
    mkdirSync(hand, { recursive: true });
    writeFileSync(path.join(hand, SKILL_FILE), i.files[0]?.content ?? "");
    const [r] = await syncSkills(env, ws, [i]);
    expect(r).toMatchObject({ status: "unchanged", dir: hand });
    expect(existsSync(at("delta"))).toBe(false);
  });

  test("命名空间里有不是同步产物的同名目录：不覆盖并报告", async () => {
    mkdirSync(at("eps"), { recursive: true });
    writeFileSync(at("eps", "mine.txt"), "keep");
    const [r] = await syncSkills(env, ws, [input("eps")]);
    expect(r?.status).toBe("conflict");
    expect(readFileSync(at("eps", "mine.txt"), "utf8")).toBe("keep");
  });

  test("一个失败不影响其他", async () => {
    // 同名文件占住了目录位置，该 skill 写不进去。
    mkdirSync(path.join(ws, ".agents/skills/yuanshu"), { recursive: true });
    writeFileSync(at("zeta"), "我是个文件");
    const out = await syncSkills(env, ws, [input("zeta"), input("eta")]);
    expect(out.map((o) => [o.name, o.status])).toEqual([
      ["zeta", "conflict"],
      ["eta", "added"],
    ]);
  });
}

describe("同步到本机环境", () => {
  behaviors(async () => new LocalEnv());

  test("全局 skill 写到用户目录的命名空间里", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "yuanshu-home-"));
    const real = process.env.HOME;
    process.env.HOME = home;
    try {
      const ws = mkdtempSync(path.join(tmpdir(), "yuanshu-ws-"));
      const [r] = await syncSkills(new LocalEnv(), ws, [
        input("glob", {}, undefined, "global"),
      ]);
      expect(r?.dir).toBe(path.join(home, ".agents/skills/yuanshu/glob"));
      expect(existsSync(path.join(r?.dir ?? "", SKILL_FILE))).toBe(true);
      rmSync(ws, { recursive: true, force: true });
    } finally {
      if (real === undefined) delete process.env.HOME;
      else process.env.HOME = real;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("环境不可用时全部标 failed，不抛出", async () => {
    class Broken {
      readonly id = "broken";
      readonly kind = "local" as const;
      readonly os = "posix" as const;
      homedir(): Promise<string> {
        return Promise.reject(new Error("连接失败"));
      }
    }
    const out = await syncSkills(new Broken() as never, "/tmp", [input("x")]);
    expect(out).toMatchObject([{ name: "x", status: "failed", dir: null }]);
    expect(out[0]?.message).toContain("连接失败");
  });
});

describe.skipIf(!hasSshd)("同步到 ssh 环境（真实 sshd）", () => {
  let sshd: TestSshd;
  let db: Db;
  let dbDir: string;
  let ssh: SshEnv | null = null;
  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());
  afterEach(() => {
    ssh?.close();
    ssh = null;
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  behaviors(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "yuanshu-sync-db-"));
    db = openDatabase(dbDir);
    const secrets = new SecretStore(db, loadMasterKey(dbDir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    ssh = new SshEnv(
      "env-sync",
      "posix",
      new SshConnection(
        {
          host: "127.0.0.1",
          port: sshd.port,
          username: sshd.user,
          secretId: key?.id ?? null,
        },
        secrets,
      ),
    );
    await ssh.connect();
    return ssh;
  });
});
