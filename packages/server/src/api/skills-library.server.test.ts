import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";
import type { SkillFetcher } from "../skills/fetch.js";

// 整机接线：createServer 里的 SkillLibrary / PiSkillFetcher 注入点、真实 EnvHub 与本机环境。
const TOKEN = "t".repeat(40);
let base: string;
let realHome: string | undefined;
let server: YuanshuServer | null = null;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-skills-srv-"));
  realHome = process.env.HOME;
  process.env.HOME = path.join(base, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(path.join(base, "web"));
  writeFileSync(path.join(base, "web", "index.html"), "<!doctype html>");
});
afterEach(async () => {
  await server?.stop();
  server = null;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(base, { recursive: true, force: true });
});

const md = (v: string) =>
  `---\nname: code-review\ndescription: 审查 diff\n---\n\n内容 ${v}\n`;

test("安装 → 待分发 → 分发到本机 → 锁定 → 补齐不越过锁定版", async () => {
  const fetcher: SkillFetcher = {
    versions: async () => ["1.5.0", "1.4.0"],
    fetch: async (_s, version) => ({
      name: "code-review",
      files: [{ path: "SKILL.md", content: Buffer.from(md(version)) }],
    }),
  };
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      token: TOKEN,
      allowCidrs: [],
    },
    {
      startDir: base,
      webRoot: path.join(base, "web"),
      skillFetcher: fetcher,
    },
  );
  const { port } = await server.start();
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: 测试里按需取响应字段
    return { status: r.status, json: (await r.json()) as any };
  };
  const copy = path.join(
    process.env.HOME as string,
    ".agents/skills/yuanshu/code-review/SKILL.md",
  );

  const installed = await call("POST", "/skills/install", {
    source: { kind: "npm", spec: "@acme/pi-skills@1.5.0" },
  });
  expect(installed.status).toBe(201);
  // 新装默认是项目级：不按环境分发，没有各环境的状态；打开全局后才有，且还没有副本
  expect(installed.json.scope).toBe("project");
  expect(installed.json.dist).toEqual([]);
  expect(existsSync(copy)).toBe(false);
  const flipped = await call("PATCH", "/skills/code-review", {
    scope: "global",
  });
  expect(flipped.status).toBe(200);
  expect((await call("GET", "/skills")).json.skills[0].dist).toEqual([
    { hostId: "local", version: null, hash: null, state: "missing" },
  ]);
  const dist = await call("POST", "/skills/code-review/distribute", {
    hostIds: ["local"],
  });
  expect(dist.json.results).toEqual([{ hostId: "local", status: "added" }]);
  expect(dist.json.skill.dist[0]).toMatchObject({
    hostId: "local",
    state: "in-sync",
    version: "1.5.0",
  });

  const locked = await call("POST", "/skills/code-review/lock", {
    version: "1.4.0",
  });
  expect(locked.json).toMatchObject({
    version: "1.4.0",
    lockedVersion: "1.4.0",
  });
  expect((await call("GET", "/skills")).json.skills[0].dist[0].state).toBe(
    "behind",
  );
  const synced = await call("POST", "/skills/code-review/sync");
  expect(synced.json.results).toEqual([{ hostId: "local", status: "updated" }]);
  expect(synced.json.skill.dist[0]).toMatchObject({
    state: "in-sync",
    version: "1.4.0",
  });

  const gone = await call("POST", "/skills/batch", {
    names: ["code-review", "ghost-skill"],
    action: "uninstall",
  });
  expect(gone.json.results.map((r: { ok: boolean }) => r.ok)).toEqual([
    true,
    false,
  ]);
  expect(existsSync(copy)).toBe(false);
});
