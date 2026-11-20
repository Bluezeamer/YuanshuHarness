import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { LinkService } from "../canvas/link.js";
import { CanvasService } from "../canvas/service.js";
import { ThumbService } from "../canvas/thumb.js";
import { EnvHub } from "../env/hub.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { canvasApi } from "./canvas.js";

let root: string;
let db: Db;
let hub: EnvHub;
let app: FastifyInstance;
let work: string;
// 资源上传的上限：每个用例按需改，beforeEach 里还原
const assetLimits = {
  uploadMaxBytes: 8 * 1024 * 1024,
  gitMaxBytes: 1024 * 1024,
};
// 接口测试用假 resize：真 WASM 只在 canvas/thumb.test.ts 里跑一次。
const resized: Array<{ bytes: number; mime: string }> = [];
const pngData = Buffer.from("thumb-png");

// 假网页：接口测试不上网
const webHits: string[] = [];
const fakeWeb: typeof fetch = async (input) => {
  const url = String(input);
  webHits.push(url);
  if (url.includes("down.test")) throw new Error("ECONNREFUSED");
  return new Response(
    '<html><head><title>示例页</title><meta property="og:description" content="一段摘要"></head></html>',
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
};

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-api-"));
  db = openDatabase(root);
  const secrets = new SecretStore(db, loadMasterKey(root));
  const environments = new EnvironmentStore(db);
  hub = new EnvHub(environments, secrets);
  app = Fastify();
  app.register(canvasApi, {
    canvas: new CanvasService({ env: (id) => hub.get(id), commitDelayMs: 10 }),
    hub,
    assetLimits: () => assetLimits,
    links: new LinkService({ fetchImpl: fakeWeb }),
    thumbs: new ThumbService({
      cacheDir: path.join(root, "cache"),
      resize: async (bytes, mime) => {
        resized.push({ bytes: bytes.length, mime });
        return { data: new Uint8Array(pngData), mime: "image/png" };
      },
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  hub.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  work = mkdtempSync(path.join(root, "w-"));
  assetLimits.uploadMaxBytes = 8 * 1024 * 1024;
  assetLimits.gitMaxBytes = 1024 * 1024;
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const base = (op: string, q: Record<string, string> = {}) =>
  `/api/v1/canvas/local/${op}?${new URLSearchParams({ dir: work, ...q })}`;

const get = (op: string, q: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: base(op, q) });

const post = (op: string, payload: unknown, q: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: base(op, q), payload: payload as object });

const patch = (op: string, payload: unknown, q: Record<string, string> = {}) =>
  app.inject({ method: "PATCH", url: base(op, q), payload: payload as object });

const del = (op: string, q: Record<string, string> = {}) =>
  app.inject({ method: "DELETE", url: base(op, q) });

const putText = (op: string, body: string, q: Record<string, string> = {}) =>
  app.inject({
    method: "PUT",
    url: base(op, q),
    headers: { "content-type": "text/plain" },
    payload: body,
  });

const putJson = (op: string, body: unknown, q: Record<string, string> = {}) =>
  app.inject({
    method: "PUT",
    url: base(op, q),
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });

test("GET /boards：纯读，不建 .canvas/；建过之后给出 ready 与清单", async () => {
  const before = await get("boards");
  expect(before.statusCode).toBe(200);
  expect(before.json()).toEqual({
    ready: false,
    git: "missing",
    boards: [],
    notes: [],
    folders: [],
  });
  await post("boards", { name: "产品想法" });
  const after = await get("boards");
  expect(after.json()).toMatchObject({
    ready: true,
    git: "ok",
    boards: [{ name: "产品想法", cards: 0 }],
  });
});

test("POST /boards：清洗名字、空名用时间、重名加序号；名字非法 400", async () => {
  const made = await post("boards", { name: "想 法*一" });
  expect(made.statusCode).toBe(201);
  expect(made.json()).toEqual({ name: "想 法一" });
  expect((await post("boards", { name: "想 法*一" })).json()).toEqual({
    name: "想 法一 (2)",
  });
  expect((await post("boards", {})).json().name).toMatch(/^\d{8}-\d{6}$/);
  expect((await post("boards", { name: 1 })).statusCode).toBe(400);
});

test("GET /board：文档原样、基线、每个引用文件的 FileInfo", async () => {
  await post("boards", { name: "b" });
  await post("cards", { board: "b", name: "风险", text: "# 风险" });
  const r = await get("board", { name: "b" });
  expect(r.statusCode).toBe(200);
  const j = r.json();
  expect(j.name).toBe("b");
  expect(j.canvas.nodes).toHaveLength(1);
  expect(j.baseline.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(j.files["b.cards/风险.md"]).toMatchObject({
    exists: true,
    kind: "card",
    preview: "# 风险",
  });
  // 图片设置的指纹：界面带进图片地址，改了设置浏览器缓存里的旧缩略图才会作废
  expect(j.mediaRev).toMatch(/^[0-9a-f]{8}$/);
});

test("PUT /board：接受 JSON，返回新基线；基线不符 409 conflict", async () => {
  await post("boards", { name: "b" });
  const cur = (await get("board", { name: "b" })).json();
  const doc = { ...cur.canvas, unknown: { keep: true } };
  const ok = await putJson("board", doc, {
    name: "b",
    expect_mtime: String(cur.baseline.mtimeMs),
    expect_sha256: cur.baseline.sha256,
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().baseline.sha256).not.toBe(cur.baseline.sha256);
  const stale = await putJson("board", doc, {
    name: "b",
    expect_sha256: cur.baseline.sha256,
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: "conflict" });
  expect(stale.json().sha256).toBe(ok.json().baseline.sha256);
  expect((await get("board", { name: "b" })).json().canvas.unknown).toEqual({
    keep: true,
  });
  const broken = await putText("board", "{oops", { name: "b" });
  expect(broken.statusCode).toBe(422);
});

test("PATCH / DELETE /board：改名连带资源文件夹，删整块画布", async () => {
  await post("boards", { name: "旧" });
  await post("cards", { board: "旧", name: "卡", text: "x" });
  const renamed = await patch("board", { name: "新" }, { name: "旧" });
  expect(renamed.json()).toEqual({ name: "新" });
  expect((await get("board", { name: "新" })).statusCode).toBe(200);
  expect((await get("board", { name: "新" })).json().canvas.nodes[0].file).toBe(
    "新.cards/卡.md",
  );
  const removed = await del("board", { name: "新" });
  expect(removed.json()).toEqual({ ok: true });
  expect((await get("board", { name: "新" })).statusCode).toBe(404);
});

test("GET / PUT /card：纯文本正文字带基线头，冲突回 409", async () => {
  await post("boards", { name: "b" });
  const made = await post("cards", { board: "b", name: "卡", text: "v1" });
  const { path: rel } = made.json();
  const r = await get("card", { path: rel });
  expect(r.statusCode).toBe(200);
  expect(r.body).toBe("v1");
  expect(r.headers["content-type"]).toContain("text/plain");
  const mtime = r.headers["x-file-mtime"] as string;
  const sha = r.headers["x-file-sha256"] as string;
  expect(sha).toMatch(/^[0-9a-f]{64}$/);

  const ok = await putText("card", "v2", {
    path: rel,
    expect_mtime: mtime,
    expect_sha256: sha,
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().baseline.sha256).not.toBe(sha);
  expect(readFileSync(path.join(work, ".canvas", rel), "utf8")).toBe("v2");

  const stale = await putText("card", "v3", { path: rel, expect_sha256: sha });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: "conflict" });
  expect(readFileSync(path.join(work, ".canvas", rel), "utf8")).toBe("v2");
});

test("POST /notes 建笔记（路径清洗、补 .md、可带子文件夹）；已存在 409；index、卡片文件夹里、空名 400", async () => {
  const made = await post("notes", { path: "产品/用户:研究", text: "# 研究" });
  expect(made.statusCode).toBe(201);
  expect(made.json()).toEqual({ path: "产品/用户研究.md" });
  expect(
    readFileSync(path.join(work, ".canvas", "产品", "用户研究.md"), "utf8"),
  ).toBe("# 研究");
  expect((await post("notes", { path: "产品/用户研究.md" })).statusCode).toBe(
    409,
  );
  for (const bad of ["index", "b.cards/x", "///", ""])
    expect((await post("notes", { path: bad })).statusCode).toBe(400);
  expect((await post("notes", {})).statusCode).toBe(400);
  expect((await post("notes", { path: "a", text: 1 })).statusCode).toBe(400);
});

test("笔记和灵感卡走同一套读写：GET / PUT /card 认笔记路径，批量保存里的 edits 也认；PATCH / DELETE /card 只认卡片", async () => {
  await post("boards", { name: "b" });
  await post("notes", { path: "n", text: "v1" });
  const r = await get("card", { path: "n.md" });
  expect(r.statusCode).toBe(200);
  expect(r.body).toBe("v1");
  const base = {
    mtimeMs: Number(r.headers["x-file-mtime"]),
    sha256: r.headers["x-file-sha256"] as string,
  };
  const ok = await putText("card", "v2", {
    path: "n.md",
    expect_sha256: base.sha256,
  });
  expect(ok.statusCode).toBe(200);
  expect(readFileSync(path.join(work, ".canvas", "n.md"), "utf8")).toBe("v2");

  const batch = await post("save", {
    board: "b",
    edits: [{ path: "n.md", text: "v3", expect: ok.json().baseline }],
  });
  expect(batch.statusCode).toBe(200);
  expect(batch.json().edits[0].path).toBe("n.md");
  expect(readFileSync(path.join(work, ".canvas", "n.md"), "utf8")).toBe("v3");

  expect(
    (await patch("card", { name: "x" }, { path: "n.md" })).statusCode,
  ).toBe(400);
  expect((await del("card", { path: "n.md" })).statusCode).toBe(400);
});

test("树：GET /boards 带 folders 与 notes；PATCH /board 的 to 能挪到别的文件夹；PATCH / DELETE /note；文件夹的建、挪、删；GET /refs；名字非法 400", async () => {
  expect((await post("folders", { path: "空" })).statusCode).toBe(201);
  expect((await post("folders", { path: "空" })).statusCode).toBe(409);
  for (const bad of ["", "a.cards", "../x", "a//b"])
    expect((await post("folders", { path: bad })).statusCode).toBe(400);
  await post("boards", { name: "板" });
  await post("notes", { path: "产品/甲", text: "见 [[板]]" });
  await post("notes", { path: "乙", text: "[[产品/甲]]" });

  const tree = (await get("boards")).json();
  expect(tree.folders).toEqual(["产品", "空"]);
  expect(tree.notes).toEqual(["乙.md", "产品/甲.md"]);
  expect(tree.boards.map((b: { name: string }) => b.name)).toEqual(["板"]);

  // 画布挪进文件夹：to 是新的完整名字；重名 409；非法 400
  const moved = await patch("board", { to: "空/新板" }, { name: "板" });
  expect(moved.json()).toEqual({ name: "空/新板" });
  expect(
    readFileSync(path.join(work, ".canvas", "产品", "甲.md"), "utf8"),
  ).toBe("见 [[空/新板]]");
  await post("boards", { name: "板2" });
  expect(
    (await patch("board", { to: "空/新板" }, { name: "板2" })).statusCode,
  ).toBe(409);
  expect(
    (await patch("board", { to: "../x" }, { name: "板2" })).statusCode,
  ).toBe(400);

  // 笔记改名 / 挪动：to 是新路径（缺 .md 补上），引用它的笔记跟着改
  const renamed = await patch("note", { to: "空/丙" }, { path: "产品/甲.md" });
  expect(renamed.json()).toEqual({ path: "空/丙.md" });
  expect(readFileSync(path.join(work, ".canvas", "乙.md"), "utf8")).toBe(
    "[[空/丙]]",
  );
  expect(
    (await patch("note", { to: "乙" }, { path: "空/丙.md" })).statusCode,
  ).toBe(409);
  expect(
    (await patch("note", { to: "index" }, { path: "空/丙.md" })).statusCode,
  ).toBe(400);
  expect(
    (await patch("note", { to: "x" }, { path: "没有.md" })).statusCode,
  ).toBe(404);
  expect(
    (await patch("note", { to: "x" }, { path: "b.cards/x.md" })).statusCode,
  ).toBe(400);

  const refs = await get("refs", { path: "空/丙.md" });
  expect(refs.json()).toEqual({ boards: [], notes: ["乙.md"] });
  expect((await get("refs", { path: "没有.md" })).statusCode).toBe(404);
  expect((await get("refs", { path: "../x.md" })).statusCode).toBe(400);

  // 文件夹挪动（改名）与删除
  expect((await patch("folder", { to: "归" }, { path: "空" })).json()).toEqual({
    path: "归",
  });
  expect(
    (await patch("folder", { to: "归/内" }, { path: "归" })).statusCode,
  ).toBe(400);
  expect(
    (await patch("folder", { to: "x" }, { path: "没有" })).statusCode,
  ).toBe(404);
  expect((await del("note", { path: "乙.md" })).json()).toEqual({ ok: true });
  expect((await del("note", { path: "乙.md" })).statusCode).toBe(404);
  expect((await del("folder", { path: "归" })).json()).toEqual({ ok: true });
  const after = (await get("boards")).json();
  expect(after.folders).toEqual(["产品"]);
  expect(after.notes).toEqual([]);
  expect(after.boards.map((b: { name: string }) => b.name)).toEqual(["板2"]);
});

test("GET /card 只允许卡片路径；逃出 .canvas/ 与画布文件都是 400", async () => {
  await post("boards", { name: "b" });
  expect((await get("card", { path: "../x.md" })).statusCode).toBe(400);
  expect((await get("card", { path: "b.canvas" })).statusCode).toBe(400);
  expect((await get("card", { path: "index.md" })).statusCode).toBe(400);
  expect((await get("card", { path: "b.cards/x.md" })).statusCode).toBe(404);
});

test("POST /cards 给了 at 就按给定坐标放；PATCH /card 改名；DELETE /card 连节点一起删", async () => {
  await post("boards", { name: "b" });
  const made = await post("cards", {
    board: "b",
    name: "卡",
    text: "x",
    at: { x: 40, y: 60 },
  });
  expect(made.statusCode).toBe(201);
  const { path: rel, nodeId } = made.json();
  expect(typeof nodeId).toBe("string");
  const board = (await get("board", { name: "b" })).json();
  expect(board.canvas.nodes[0]).toMatchObject({ id: nodeId, x: 40, y: 60 });

  const renamed = await patch("card", { name: "新卡" }, { path: rel });
  expect(renamed.json()).toEqual({ path: "b.cards/新卡.md" });
  await del("card", { path: "b.cards/新卡.md" });
  const after = (await get("board", { name: "b" })).json();
  expect(after.canvas.nodes).toEqual([]);
});

test("GET /history、/history/version、POST /restore 与 /undo", async () => {
  await post("boards", { name: "b" });
  const made = await post("cards", { board: "b", name: "卡", text: "v1" });
  const rel = made.json().path as string;
  // 界面保存两次，产生两个 user 提交
  // 读历史前会先 settle：这一步就产生一次提交
  await get("history", { path: rel });
  const cur = await get("card", { path: rel });
  await putText("card", "v2", {
    path: rel,
    expect_sha256: cur.headers["x-file-sha256"] as string,
  });
  await get("history", { path: rel });
  const cur2 = await get("card", { path: rel });
  await putText("card", "v3", {
    path: rel,
    expect_sha256: cur2.headers["x-file-sha256"] as string,
  });
  const history = (await get("history", { path: rel })).json().commits;
  expect(history.length).toBeGreaterThanOrEqual(2);
  expect(history[0]?.source).toBe("user");
  const oldest = history.at(-1);
  const version = await get("history/version", { sha: oldest.sha, path: rel });
  expect(version.statusCode).toBe(200);
  expect(version.body).toBe("v1");
  expect(
    (await get("history/version", { sha: "deadbeef", path: rel })).statusCode,
  ).toBe(404);

  const restored = await post("restore", { path: rel, sha: oldest.sha });
  expect(restored.statusCode).toBe(200);
  expect(restored.json().sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(readFileSync(path.join(work, ".canvas", rel), "utf8")).toBe("v1");
  expect((await get("history")).json().commits[0].source).toBe("restore");

  // 头一条不是 agent 提交：不能撤销
  const undo = await post("undo", {});
  expect(undo.statusCode).toBe(409);
  expect(undo.json()).toMatchObject({ error: "undo_failed" });
});

test("环境不存在 404；dir 缺失或不是绝对路径 400；目录不存在 404", async () => {
  const noEnv = await app.inject({
    method: "GET",
    url: `/api/v1/canvas/nope/boards?${new URLSearchParams({ dir: work })}`,
  });
  expect(noEnv.statusCode).toBe(404);
  expect(noEnv.json()).toEqual({ error: "env_not_found" });

  expect(
    (await app.inject({ method: "GET", url: "/api/v1/canvas/local/boards" }))
      .statusCode,
  ).toBe(400);
  expect((await get("boards")).statusCode).toBe(200);
  const rel = await app.inject({
    method: "GET",
    url: "/api/v1/canvas/local/boards?dir=relative",
  });
  expect(rel.statusCode).toBe(400);
  const missing = await app.inject({
    method: "GET",
    url: `/api/v1/canvas/local/boards?${new URLSearchParams({ dir: path.join(work, "nope") })}`,
  });
  expect(missing.statusCode).toBe(404);

  const file = path.join(work, "a.txt");
  writeFileSync(file, "x");
  const notDir = await app.inject({
    method: "GET",
    url: `/api/v1/canvas/local/boards?${new URLSearchParams({ dir: file })}`,
  });
  expect(notDir.statusCode).toBe(400);
});

test("sha 形状不合法时 400（命令是拼字符串执行的，这里是注入边界）", async () => {
  await post("boards", { name: "b" });
  const made = await post("cards", { board: "b", name: "卡", text: "x" });
  const rel = made.json().path as string;
  for (const sha of ["--output=/tmp/x", "HEAD", "zzzzzzz"]) {
    const r = await get("history/version", { sha, path: rel });
    expect(r.statusCode).toBe(400);
    const restore = await post("restore", { path: rel, sha });
    expect(restore.statusCode).toBe(400);
  }
});

test("路径逃逸在接口层就被拒（history / version / restore）", async () => {
  await post("boards", { name: "b" });
  expect((await get("history", { path: "../x" })).statusCode).toBe(400);
  expect(
    (await get("history/version", { sha: "abcdef1", path: "../../etc/passwd" }))
      .statusCode,
  ).toBe(400);
  expect(
    (await post("restore", { path: "../x", sha: "abcdef1" })).statusCode,
  ).toBe(400);
});

test("PUT 只在这个作用域换内容类型解析器：其他路由仍按默认解析", async () => {
  // 同一个 app 实例上没有别的 PUT 路由可验，这里确认 JSON 与文本都能进 Board/Card
  await post("boards", { name: "b" });
  const text = await putText("board", '{"nodes":[],"edges":[]}', { name: "b" });
  expect(text.statusCode).toBe(200);
  const made = await post("cards", { board: "b", name: "卡", text: "x" });
  const json = await putText("card", "plain body", { path: made.json().path });
  expect(json.statusCode).toBe(200);
  expect(
    readFileSync(path.join(work, ".canvas", made.json().path), "utf8"),
  ).toBe("plain body");
});

test("缺画布时创建卡片 404，什么都不留下", async () => {
  await post("boards", { name: "b" });
  const r = await post("cards", { board: "nope", text: "x" });
  expect(r.statusCode).toBe(404);
});

test("POST /cards 只带 text 与 at（不给 name）：正文与坐标都落盘", async () => {
  await post("boards", { name: "b" });
  const made = await post("cards", {
    board: "b",
    text: "随手记",
    at: { x: 12, y: 34 },
  });
  expect(made.statusCode).toBe(201);
  const { path: rel, nodeId } = made.json();
  expect(rel).toMatch(/^b\.cards\/\d{8}-\d{6}\.md$/);
  expect((await get("card", { path: rel })).body).toBe("随手记");
  const node = (await get("board", { name: "b" })).json().canvas.nodes[0];
  expect(node).toMatchObject({ id: nodeId, x: 12, y: 34, file: rel });
});

test("GET /board：非 md 的项目文件引用带 mtimeMs，长卡片带 truncated", async () => {
  await post("boards", { name: "b" });
  writeFileSync(path.join(work, "pic.png"), Buffer.alloc(2048, 1));
  const made = await post("cards", {
    board: "b",
    name: "长",
    text: "字".repeat(5000),
  });
  const cur = (await get("board", { name: "b" })).json();
  const doc = {
    ...cur.canvas,
    nodes: [
      ...cur.canvas.nodes,
      {
        id: "n1",
        type: "file",
        file: "../pic.png",
        x: 400,
        y: 0,
        width: 260,
        height: 160,
      },
    ],
  };
  expect((await putJson("board", doc, { name: "b" })).statusCode).toBe(200);
  const files = (await get("board", { name: "b" })).json().files;
  // 前端拼图片 URL 的 v 参数要用它
  expect(files["../pic.png"]).toMatchObject({
    exists: true,
    kind: "ref",
    size: 2048,
  });
  expect(typeof files["../pic.png"].mtimeMs).toBe("number");
  expect(files["../pic.png"].preview).toBeUndefined();
  const card = files[made.json().path];
  expect(card.preview).toHaveLength(4000);
  expect(card.truncated).toBe(true);
});

test("GET /image：缩略图头；带 v 时 immutable，不带 v 时 no-cache", async () => {
  writeFileSync(path.join(work, "pic.png"), Buffer.alloc(2048, 1));
  const before = resized.length;
  const thumb = await get("image", { file: "../pic.png", v: "1" });
  expect(thumb.statusCode).toBe(200);
  expect(thumb.headers["content-type"]).toBe("image/png");
  expect(thumb.headers["x-canvas-image"]).toBe("thumb");
  expect(thumb.headers["cache-control"]).toBe(
    "private, max-age=31536000, immutable",
  );
  expect(thumb.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  expect(thumb.rawPayload).toEqual(pngData);
  const again = await get("image", { file: "../pic.png" });
  expect(again.headers["cache-control"]).toBe("no-cache");
  expect(again.headers.etag).toBe(thumb.headers.etag);
  // 第二次命中缓存，不再进 resize
  expect(resized).toHaveLength(before + 1);
});

test("GET /image：svg 原样返回，带 CSP 与 nosniff", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  writeFileSync(path.join(work, "icon.svg"), svg);
  const r = await get("image", { file: "../icon.svg" });
  expect(r.statusCode).toBe(200);
  expect(r.headers["content-type"]).toBe("image/svg+xml");
  expect(r.headers["content-security-policy"]).toBe("sandbox");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["x-canvas-image"]).toBe("raw");
  expect(r.body).toBe(svg);
});

test("GET /image：413、415、404、路径逃逸与不认的相对路径都是 400", async () => {
  const big = Buffer.alloc(20 * 1024 * 1024 + 1);
  writeFileSync(path.join(work, "big.png"), big);
  const tooLarge = await get("image", { file: "../big.png" });
  expect(tooLarge.statusCode).toBe(413);
  expect(tooLarge.json()).toMatchObject({
    error: "too_large",
    size: big.length,
    max: 20 * 1024 * 1024,
  });

  writeFileSync(path.join(work, "a.txt"), "x");
  const txt = await get("image", { file: "../a.txt" });
  expect(txt.statusCode).toBe(415);
  expect(txt.json()).toMatchObject({ error: "unsupported" });

  const gone = await get("image", { file: "../gone.png" });
  expect(gone.statusCode).toBe(404);
  expect(gone.json()).toMatchObject({ error: "not_found" });

  const escaped = await get("image", { file: "../../etc/passwd.png" });
  expect(escaped.statusCode).toBe(400);
  expect(escaped.json()).toMatchObject({ error: "invalid_path" });

  // 卡片是 markdown，不走这里：不带 ../ 的路径一律 400
  const card = await get("image", { file: "b.cards/x.md" });
  expect(card.statusCode).toBe(400);
  expect(card.json()).toMatchObject({ error: "invalid_path" });
});

test("POST /save：文档、改过的卡片、新卡片一次落盘，回基线与新卡片的路径；文档过期 409 且什么都不写；体不对 400", async () => {
  await post("boards", { name: "b" });
  const card = (await post("cards", { board: "b", text: "旧" })).json() as {
    path: string;
  };
  const read = (await get("board", { name: "b" })).json() as {
    canvas: { nodes: Array<Record<string, unknown>> };
    baseline: { mtimeMs: number; sha256: string };
  };
  const cardBase = (await get("card", { path: card.path })).headers;
  const doc = {
    ...read.canvas,
    nodes: [
      ...read.canvas.nodes,
      {
        id: "n1",
        type: "file",
        file: "::new:1",
        x: 9,
        y: 9,
        width: 260,
        height: 160,
      },
    ],
  };

  const stale = await post("save", {
    board: "b",
    doc,
    expect: { sha256: "0".repeat(64) },
    edits: [{ path: card.path, text: "新" }],
    created: [{ nodeId: "n1", text: "x" }],
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: "conflict" });
  expect(readFileSync(path.join(work, ".canvas", card.path), "utf8")).toBe(
    "旧",
  );

  const ok = await post("save", {
    board: "b",
    doc,
    expect: read.baseline,
    edits: [
      {
        path: card.path,
        text: "新",
        expect: {
          mtimeMs: Number(cardBase["x-file-mtime"]),
          sha256: cardBase["x-file-sha256"],
        },
      },
    ],
    created: [{ nodeId: "n1", text: "" }],
  });
  expect(ok.statusCode).toBe(200);
  const body = ok.json() as {
    baseline: { sha256: string };
    edits: Array<{ path: string }>;
    created: Array<{ nodeId: string; path: string }>;
    conflicts: string[];
  };
  expect(body.edits.map((e) => e.path)).toEqual([card.path]);
  expect(body.created).toHaveLength(1);
  expect(body.conflicts).toEqual([]);
  const after = (await get("board", { name: "b" })).json() as {
    canvas: { nodes: Array<{ id: string; file: string }> };
    baseline: { sha256: string };
  };
  expect(after.baseline.sha256).toBe(body.baseline.sha256);
  expect(after.canvas.nodes.find((n) => n.id === "n1")?.file).toBe(
    body.created[0]?.path,
  );

  expect((await post("save", { board: "../x" })).statusCode).toBe(400);
  expect(
    (await post("save", { board: "b", edits: [{ path: 1 }] })).statusCode,
  ).toBe(400);
  expect((await post("save", { board: "b", doc: [] })).statusCode).toBe(400);
});

test("GET /media：音视频带 Range 流式给出（206 + Content-Range），不带 Range 给全文；416、415、404、路径逃逸", async () => {
  const bytes = Buffer.from("0123456789".repeat(100));
  writeFileSync(path.join(work, "clip.mp4"), bytes);
  const full = await get("media", { file: "../clip.mp4" });
  expect(full.statusCode).toBe(200);
  expect(full.headers["content-type"]).toBe("video/mp4");
  expect(full.headers["accept-ranges"]).toBe("bytes");
  expect(full.rawPayload.equals(bytes)).toBe(true);

  const part = await app.inject({
    method: "GET",
    url: base("media", { file: "../clip.mp4" }),
    headers: { range: "bytes=10-19" },
  });
  expect(part.statusCode).toBe(206);
  expect(part.headers["content-range"]).toBe("bytes 10-19/1000");
  expect(part.headers["content-length"]).toBe("10");
  expect(part.rawPayload.toString()).toBe("0123456789");

  // 浏览器常发开放末端的 Range：从偏移到末尾
  const tail = await app.inject({
    method: "GET",
    url: base("media", { file: "../clip.mp4" }),
    headers: { range: "bytes=990-" },
  });
  expect(tail.statusCode).toBe(206);
  expect(tail.headers["content-range"]).toBe("bytes 990-999/1000");

  const past = await app.inject({
    method: "GET",
    url: base("media", { file: "../clip.mp4" }),
    headers: { range: "bytes=5000-" },
  });
  expect(past.statusCode).toBe(416);
  expect(past.headers["content-range"]).toBe("bytes */1000");

  // 带 v：浏览器可长期缓存；不带：每次校验
  const v = await get("media", { file: "../clip.mp4", v: "1" });
  expect(v.headers["cache-control"]).toContain("immutable");
  expect(full.headers["cache-control"]).toBe("no-cache");

  writeFileSync(path.join(work, "a.txt"), "x");
  expect((await get("media", { file: "../a.txt" })).statusCode).toBe(415);
  expect((await get("media", { file: "../gone.mp4" })).statusCode).toBe(404);
  expect((await get("media", { file: "../../etc/x.mp4" })).statusCode).toBe(
    400,
  );
  // 卡片与别的 .canvas 内部路径不是媒体
  expect((await get("media", { file: "b.cards/x.mp3" })).statusCode).toBe(400);
});

test("GET /image 与 /media 也认这块画布自己的资源（<画布>.assets/…），其余 .canvas 内部路径与 .. 仍是 400", async () => {
  await post("boards", { name: "b" });
  const dir = path.join(work, ".canvas", "b.assets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "p.png"), Buffer.alloc(100, 1));
  writeFileSync(path.join(dir, "v.webm"), Buffer.from("webm-bytes"));
  const img = await get("image", { file: "b.assets/p.png" });
  expect(img.statusCode).toBe(200);
  expect(img.headers["x-canvas-image"]).toBe("thumb");
  const vid = await get("media", { file: "b.assets/v.webm" });
  expect(vid.statusCode).toBe(200);
  expect(vid.headers["content-type"]).toBe("video/webm");
  expect(vid.rawPayload.toString()).toBe("webm-bytes");
  for (const file of [
    "b.assets/../../b.canvas",
    "b.assets",
    "b.canvas",
    "index.md",
  ]) {
    expect((await get("image", { file })).statusCode).toBe(400);
    expect((await get("media", { file })).statusCode).toBe(400);
  }
});

test("GET /image 与 /media 带 host：读那台主机上的绝对路径（目录之外的也行），主机不存在 503，host 配相对路径 400，不带 host 的绝对路径仍是 400", async () => {
  await post("boards", { name: "b" });
  const outside = mkdtempSync(path.join(root, "outside-"));
  writeFileSync(path.join(outside, "p.png"), Buffer.alloc(100, 1));
  writeFileSync(path.join(outside, "v.webm"), Buffer.from("webm-bytes"));
  const png = path.join(outside, "p.png");
  const vid = path.join(outside, "v.webm");
  const img = await get("image", { file: png, host: "local" });
  expect(img.statusCode).toBe(200);
  expect(img.headers["x-canvas-image"]).toBe("thumb");
  const media = await get("media", { file: vid, host: "local" });
  expect(media.statusCode).toBe(200);
  expect(media.rawPayload.toString()).toBe("webm-bytes");
  // Range 也照常
  const part = await app.inject({
    method: "GET",
    url: base("media", { file: vid, host: "local" }),
    headers: { range: "bytes=0-3" },
  });
  expect(part.statusCode).toBe(206);
  expect(part.rawPayload.toString()).toBe("webm");
  expect((await get("image", { file: png, host: "ghost" })).statusCode).toBe(
    503,
  );
  expect((await get("media", { file: vid, host: "ghost" })).json()).toEqual({
    error: "host_unreachable",
  });
  expect(
    (await get("image", { file: "../p.png", host: "local" })).statusCode,
  ).toBe(400);
  expect((await get("image", { file: png })).statusCode).toBe(400);
  expect((await get("media", { file: vid })).statusCode).toBe(400);
});

const putAsset = (payload: Buffer, q: Record<string, string>) =>
  app.inject({
    method: "PUT",
    url: base("asset", q),
    headers: { "content-type": "application/octet-stream" },
    payload,
  });

test("PUT /asset：字节流落到资源文件夹并把节点放进画布；超过 1MB 的体也能收；大于「进历史上限」的进 _large/；DELETE 连节点一起删", async () => {
  await post("boards", { name: "b" });
  const small = await putAsset(Buffer.alloc(300 * 1024, 1), {
    board: "b",
    name: "图 1.PNG",
    x: "40",
    y: "60",
    w: "320",
    h: "240",
  });
  expect(small.statusCode).toBe(201);
  expect(small.json()).toMatchObject({
    path: "b.assets/图 1.png",
    large: false,
    size: 300 * 1024,
  });
  // 比 Fastify 默认的 1MB 体上限大：流式收
  const big = await putAsset(Buffer.alloc(3 * 1024 * 1024, 2), {
    board: "b",
    name: "clip.mp4",
  });
  expect(big.statusCode).toBe(201);
  expect(big.json()).toMatchObject({
    path: "b.assets/_large/clip.mp4",
    large: true,
  });
  expect(
    readFileSync(path.join(work, ".canvas", "b.assets/_large/clip.mp4")).length,
  ).toBe(3 * 1024 * 1024);

  const read = (await get("board", { name: "b" })).json() as {
    canvas: { nodes: Array<Record<string, unknown>> };
  };
  expect(read.canvas.nodes[0]).toMatchObject({
    file: "b.assets/图 1.png",
    x: 40,
    y: 60,
    width: 320,
    height: 240,
  });
  expect(read.canvas.nodes).toHaveLength(2);

  const removed = await del("asset", { path: "b.assets/图 1.png" });
  expect(removed.statusCode).toBe(200);
  const after = (await get("board", { name: "b" })).json() as {
    canvas: { nodes: unknown[] };
  };
  expect(after.canvas.nodes).toHaveLength(1);
  expect((await del("asset", { path: "b.assets/图 1.png" })).statusCode).toBe(
    404,
  );
  expect((await del("asset", { path: "b.cards/x.md" })).statusCode).toBe(400);
});

test("PUT /note-asset：字节流存进笔记所在文件夹的 .assets/<笔记名>/，返回相对 .canvas/ 的路径；/image 能读出来；改名带走；超限 413、不是笔记 400、笔记不存在 404", async () => {
  await post("notes", { path: "产品/访谈", text: "x" });
  const put = (
    q: Record<string, string>,
    payload = Buffer.alloc(300 * 1024, 1),
  ) =>
    app.inject({
      method: "PUT",
      url: base("note-asset", q),
      headers: { "content-type": "application/octet-stream" },
      payload,
    });
  const ok = await put({ note: "产品/访谈.md", name: "图 1.PNG" });
  expect(ok.statusCode).toBe(201);
  expect(ok.json()).toMatchObject({
    path: "产品/.assets/访谈/图 1.png",
    large: false,
    size: 300 * 1024,
  });
  expect(
    readFileSync(path.join(work, ".canvas", "产品/.assets/访谈/图 1.png"))
      .length,
  ).toBe(300 * 1024);
  const image = await get("image", { file: "产品/.assets/访谈/图 1.png" });
  expect(image.statusCode).toBe(200);
  // 根目录的笔记在 .canvas/.assets/<笔记名>/ 下，同样读得出来
  await post("notes", { path: "总览", text: "x" });
  const rootPut = await put({ note: "总览.md", name: "a.png" });
  expect(rootPut.json()).toMatchObject({ path: ".assets/总览/a.png" });
  expect((await get("image", { file: ".assets/总览/a.png" })).statusCode).toBe(
    200,
  );

  const patched = await app.inject({
    method: "PATCH",
    url: base("note", { path: "产品/访谈.md" }),
    payload: { to: "产品/总结.md" },
  });
  expect(patched.statusCode).toBe(200);
  expect(
    existsSync(path.join(work, ".canvas", "产品/.assets/总结/图 1.png")),
  ).toBe(true);

  expect((await put({ note: "没有.md", name: "a.png" })).statusCode).toBe(404);
  expect((await put({ note: "板.canvas", name: "a.png" })).statusCode).toBe(
    400,
  );
  expect((await put({ note: "../x.md", name: "a.png" })).statusCode).toBe(400);
  expect((await put({ note: "产品/总结.md", name: "" })).statusCode).toBe(400);
  assetLimits.uploadMaxBytes = 100 * 1024;
  expect((await put({ note: "产品/总结.md", name: "a.bin" })).statusCode).toBe(
    413,
  );
  assetLimits.uploadMaxBytes = 8 * 1024 * 1024;
});

test("PUT /asset：超过上传上限 413（声明的长度一读到就拒，什么都不留）；画布不存在 404；名字或位置不对 400", async () => {
  await post("boards", { name: "b" });
  assetLimits.uploadMaxBytes = 100 * 1024;
  const tooBig = await putAsset(Buffer.alloc(200 * 1024, 1), {
    board: "b",
    name: "a.bin",
  });
  expect(tooBig.statusCode).toBe(413);
  expect(tooBig.json()).toMatchObject({
    error: "too_large",
    max: 100 * 1024,
  });
  const dir = path.join(work, ".canvas", "b.assets");
  const leftovers = () =>
    ["", "_large"].flatMap((d) => {
      try {
        return readdirSync(path.join(dir, d));
      } catch {
        return [];
      }
    });
  expect(leftovers().filter((n) => !n.startsWith("_"))).toEqual([]);

  assetLimits.uploadMaxBytes = 8 * 1024 * 1024;
  expect(
    (await putAsset(Buffer.alloc(10), { board: "没有", name: "a.bin" }))
      .statusCode,
  ).toBe(404);
  expect(
    (await putAsset(Buffer.alloc(10), { board: "../x", name: "a" })).statusCode,
  ).toBe(400);
  expect(
    (await putAsset(Buffer.alloc(10), { board: "b", name: "" })).statusCode,
  ).toBe(400);
  expect(
    (
      await putAsset(Buffer.alloc(10), {
        board: "b",
        name: "a",
        x: "abc",
        y: "1",
      })
    ).statusCode,
  ).toBe(400);
  expect(leftovers().filter((n) => n.endsWith(".part"))).toEqual([]);
});

test("GET /link：只认 http(s)；抓到给标题与摘要，抓不到也是 200 但 failed，地址相同不重复抓", async () => {
  const link = (url: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/canvas/local/link?${new URLSearchParams({ url })}`,
    });
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "不是地址",
    "",
  ])
    expect((await link(bad)).statusCode).toBe(400);
  const ok = await link("http://example.test/a");
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({
    title: "示例页",
    description: "一段摘要",
    failed: false,
  });
  const n = webHits.length;
  await link("http://example.test/a");
  expect(webHits.length).toBe(n);
  const down = await link("http://down.test/");
  expect(down.statusCode).toBe(200);
  expect(down.json()).toMatchObject({ title: null, failed: true });
  expect(down.headers["cache-control"]).toBe("no-store");
});
