import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";

// 全局 AGENTS.md 的文件状态与「从磁盘导入」：文件在传入的 ysHome 下，与真实 ~/.ys 无关。
const TOKEN = "t".repeat(40);
let base: string;
let server: YuanshuServer | null = null;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-agentsmd-api-"));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(base, { recursive: true, force: true });
});

const mk = (...p: string[]) => {
  const d = path.join(base, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};

async function launch() {
  const dataDir = mk("data");
  const ysHome = path.join(base, "ys");
  const webRoot = mk("web");
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html>");
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      ysHome,
      token: TOKEN,
      allowCidrs: [],
    },
    { startDir: mk("start"), webRoot },
  );
  const addr = await server.start();
  const call = (method: string, p: string, body?: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${addr.port}${p}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // 响应形状随接口不同，测试里直接按字段取
  const json = async (method: string, p: string, body?: unknown) => {
    const r = await call(method, p, body);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const globalFile = path.join(ysHome, "AGENTS.md");
  const activePreset = async () => {
    const r = await json("GET", "/api/v1/studio/presets?kind=global-agentsmd");
    const presets = r.body.presets as { id: string; active: boolean }[];
    return presets.filter((p) => p.active);
  };
  return { call, json, ysHome, globalFile, activePreset };
}

test("GET 只给文件状态：路径、是否存在、有没有被人改过；没有内容字段", async () => {
  const { json, ysHome, globalFile } = await launch();
  const empty = await json("GET", "/api/v1/agents-md/global");
  expect(empty.status).toBe(200);
  expect(empty.body).toEqual({
    path: path.join(ysHome, "AGENTS.md"),
    exists: false,
    modified: false,
  });

  mkdirSync(ysHome, { recursive: true });
  writeFileSync(globalFile, "手写的约定\n");
  expect((await json("GET", "/api/v1/agents-md/global")).body).toEqual({
    path: path.join(ysHome, "AGENTS.md"),
    exists: true,
    modified: true,
  });
});

test("PUT 已删除：全局文件只能经预设写入", async () => {
  const { call } = await launch();
  const r = await call("PUT", "/api/v1/agents-md/global", { content: "x" });
  expect(r.status).toBe(404);
});

test("import：磁盘上有内容时做成一个版本并设为生效，之后不再算被改过", async () => {
  const { json, ysHome, globalFile, activePreset } = await launch();
  mkdirSync(ysHome, { recursive: true });
  writeFileSync(globalFile, "\n手写的约定\n第二行\n");
  const r = await json("POST", "/api/v1/agents-md/global/import");
  expect(r.status).toBe(201);
  const preset = r.body.preset as {
    id: string;
    kind: string;
    name: string;
    description: string;
    active: boolean;
  };
  expect(preset.kind).toBe("global-agentsmd");
  expect(preset.active).toBe(true);
  expect(preset.name).toMatch(/^从磁盘导入 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(preset.description).toBe("导入时磁盘上的内容");

  // 版本里是一张卡片，正文就是导入时的原文
  const detail = await json("GET", `/api/v1/studio/presets/${preset.id}`);
  const nodes = detail.body.preset.nodes as {
    tag: string | null;
    items: { kind: string; cardId: string }[];
  }[];
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.tag).toBeNull();
  const cardId = nodes[0]?.items[0]?.cardId as string;
  const cards = (await json("GET", "/api/v1/studio/cards")).body.groups as {
    cards: { id: string; title: string; body: string }[];
  }[];
  const card = cards.flatMap((g) => g.cards).find((c) => c.id === cardId);
  expect(card?.body).toBe("\n手写的约定\n第二行\n");

  expect((await activePreset()).map((p) => p.id)).toEqual([preset.id]);
  expect((await json("GET", "/api/v1/agents-md/global")).body).toMatchObject({
    exists: true,
    modified: false,
  });
  expect(readFileSync(globalFile, "utf8")).toBe("\n手写的约定\n第二行\n");
});

test("import：文件不存在或只有空白都是 409 empty，不建版本", async () => {
  const { json, ysHome, globalFile, activePreset } = await launch();
  const missing = await json("POST", "/api/v1/agents-md/global/import");
  expect(missing.status).toBe(409);
  expect(missing.body).toEqual({ error: "empty" });

  mkdirSync(ysHome, { recursive: true });
  writeFileSync(globalFile, "  \n\t\n");
  const blank = await json("POST", "/api/v1/agents-md/global/import");
  expect(blank.status).toBe(409);
  expect(blank.body).toEqual({ error: "empty" });

  expect(await activePreset()).toEqual([]);
  expect(
    (await json("GET", "/api/v1/studio/presets?kind=global-agentsmd")).body
      .presets,
  ).toEqual([]);
});

test("未带令牌 401", async () => {
  const { call } = await launch();
  for (const [method, p] of [
    ["GET", "/api/v1/agents-md/global"],
    ["POST", "/api/v1/agents-md/global/import"],
  ] as const) {
    expect((await call(method, p, undefined, false)).status).toBe(401);
  }
});
