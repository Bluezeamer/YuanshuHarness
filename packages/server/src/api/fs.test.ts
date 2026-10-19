import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";

const TOKEN = "t".repeat(40);
const isRoot = process.getuid?.() === 0;
let base: string;
let server: YuanshuServer | null = null;
const realHome = process.env.HOME;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-fs-"));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  process.env.HOME = realHome;
  rmSync(base, { recursive: true, force: true });
});

const mk = (...p: string[]) => {
  const d = path.join(base, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};

async function launch() {
  const dataDir = mk("data");
  server = createServer(
    { host: "127.0.0.1", port: 0, dataDir, token: TOKEN, allowCidrs: [] },
    { startDir: mk("start") },
  );
  const addr = await server.start();
  const get = (q: string, auth = true) =>
    fetch(`http://127.0.0.1:${addr.port}/api/v1/fs/dirs${q}`, {
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    });
  const list = async () =>
    (
      await fetch(`http://127.0.0.1:${addr.port}/api/v1/workspaces`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
  return { get, list };
}

interface Body {
  path: string;
  parent: string | null;
  dirs: string[];
  readable: boolean;
  writable: boolean;
  truncated: boolean;
  error?: string;
}
const q = (p: string, extra = "") => `?path=${encodeURIComponent(p)}${extra}`;

describe("R1 入口与参数", () => {
  test("未带令牌 401", async () => {
    const { get } = await launch();
    expect((await get("", false)).status).toBe(401);
  });

  test("path 缺省为 home", async () => {
    const home = mk("home");
    mk("home", "alpha");
    process.env.HOME = home;
    const { get } = await launch();
    const res = await get("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.path).toBe(path.resolve(home));
    expect(body.dirs).toEqual(["alpha"]);
  });

  test.each([
    ["相对路径", () => "relative/dir"],
    ["不存在", () => path.join(base, "nope")],
    [
      "文件",
      () => {
        const f = path.join(base, "f.txt");
        writeFileSync(f, "x");
        return f;
      },
    ],
  ])("%s 返回 400 invalid_path", async (_n, make) => {
    const { get } = await launch();
    const res = await get(q(make()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Body).error).toBe("invalid_path");
  });
});

describe("R2 只含目录名", () => {
  test("文件、悬空链接不出现；目录链接算目录；path 为 realpath", async () => {
    const root = mk("tree");
    mk("tree", "sub-b");
    mk("tree", "sub-a");
    writeFileSync(path.join(root, "file.txt"), "x");
    symlinkSync(mk("elsewhere"), path.join(root, "link-dir"));
    symlinkSync(path.join(base, "gone"), path.join(root, "dangling"));
    symlinkSync(path.join(root, "file.txt"), path.join(root, "link-file"));
    symlinkSync(root, path.join(base, "tree-link"));
    const { get } = await launch();
    const body = (await (
      await get(q(path.join(base, "tree-link")))
    ).json()) as Body;
    expect(body.dirs).toEqual(["link-dir", "sub-a", "sub-b"]);
    expect(body.path).toBe(path.join(mk("tree")));
    expect(body.parent).toBe(path.dirname(body.path));
  });

  test("根目录 parent 为 null", async () => {
    const { get } = await launch();
    const body = (await (await get(q("/"))).json()) as Body;
    expect(body.path).toBe("/");
    expect(body.parent).toBeNull();
  });
});

describe("R3 隐藏、排序、截断", () => {
  test("点目录默认隐藏，hidden=1 出现", async () => {
    const root = mk("h");
    mk("h", ".git");
    mk("h", "src");
    const { get } = await launch();
    expect(((await (await get(q(root))).json()) as Body).dirs).toEqual(["src"]);
    expect(
      ((await (await get(q(root, "&hidden=1"))).json()) as Body).dirs,
    ).toEqual([".git", "src"]);
  });

  test("2001 项截断为 2000 并 truncated=true", async () => {
    const root = mk("many");
    for (let i = 0; i < 2001; i++) mkdirSync(path.join(root, `d${i}`));
    const { get } = await launch();
    const body = (await (await get(q(root))).json()) as Body;
    expect(body.dirs).toHaveLength(2000);
    expect(body.truncated).toBe(true);
    const few = mk("few");
    const small = (await (await get(q(few))).json()) as Body;
    expect(small.truncated).toBe(false);
  });
});

describe("R4 权限探测", () => {
  test.skipIf(isRoot)("chmod 000：200、空 dirs、readable=false", async () => {
    const d = mk("locked");
    mk("locked", "inner");
    chmodSync(d, 0o000);
    try {
      const { get } = await launch();
      const res = await get(q(d));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body.dirs).toEqual([]);
      expect(body.readable).toBe(false);
      expect(body.writable).toBe(false);
    } finally {
      chmodSync(d, 0o755);
    }
  });

  test.skipIf(isRoot)("只读目录 writable=false，readable=true", async () => {
    const d = mk("ro");
    chmodSync(d, 0o555);
    try {
      const { get } = await launch();
      const body = (await (await get(q(d))).json()) as Body;
      expect(body.readable).toBe(true);
      expect(body.writable).toBe(false);
    } finally {
      chmodSync(d, 0o755);
    }
  });

  test("普通目录 readable 与 writable 均为 true", async () => {
    const { get } = await launch();
    const body = (await (await get(q(mk("rw")))).json()) as Body;
    expect(body.readable).toBe(true);
    expect(body.writable).toBe(true);
  });
});

describe("R5 无副作用", () => {
  test("调用前后 workspaces 表不变", async () => {
    const { get, list } = await launch();
    const before = await list();
    await get(q(mk("x")));
    await get(q(mk("x"), "&hidden=1"));
    expect(await list()).toEqual(before);
  });
});
