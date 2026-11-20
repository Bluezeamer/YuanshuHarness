import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  CanvasDocJson,
  CanvasNodeJson,
  FileInfo,
} from "../../../../api/canvas";
import { saveToken } from "../../../../api/http";
import {
  type Call,
  fakeFetch,
  type Handler,
  json,
} from "../../../../test/dialogsServer";
import { isNewFile, newFile } from "./model";
import { previewRemove } from "./navTree";
import { createCanvasStore, isDirty } from "./store";

const node = (
  id: string,
  extra: Partial<CanvasNodeJson> = {},
): CanvasNodeJson => ({
  id,
  type: "file",
  file: `boards/板.cards/${id}.md`,
  x: 0,
  y: 0,
  width: 260,
  height: 160,
  ...extra,
});

// 一个只认画布接口的假服务端：每块画布一份文档与版本号，基线由版本号推出；卡片同理
interface Board {
  doc: CanvasDocJson;
  rev: number;
}
interface Card {
  text: string;
  rev: number;
}
let boards: Map<string, Board>;
let cards: Map<string, Card>;
let files: Record<string, FileInfo>;
let calls: Call[];
let seq = 0;
/** 假服务端当前的图片设置指纹 */
let mediaRev = "aaaaaaaa";
/** 服务端收到保存请求时的钩子：测「保存期间又有改动」用 */
let onSave: (() => void) | null = null;

const baseline = (b: { rev: number }) => ({
  mtimeMs: 1000 + b.rev,
  sha256: b.rev.toString(16).padStart(64, "0"),
});

/** 模拟 agent 或别处改了卡片 */
const externalCard = (path: string, text: string) => {
  const c = cards.get(path);
  if (c) cards.set(path, { text, rev: c.rev + 1 });
};

/** 模拟 agent 或别处改了画布文件 */
const external = (name: string, doc: CanvasDocJson) => {
  const b = boards.get(name);
  if (b) boards.set(name, { doc, rev: b.rev + 1 });
};

const server: Handler = (c) => {
  const q = c.url.searchParams;
  const name = q.get("name") ?? "";
  if (c.method === "GET" && c.path.endsWith("/boards"))
    return json({
      ready: true,
      git: "ok",
      folders: [],
      notes: [],
      boards: [...boards.keys()].map((n) => ({
        name: n,
        cards: 1,
        mtimeMs: 1,
      })),
    });
  if (c.method === "GET" && c.path.endsWith("/board")) {
    const b = boards.get(name);
    return b
      ? json({
          name,
          canvas: b.doc,
          baseline: baseline(b),
          files,
          mediaRev: mediaRev,
        })
      : json({ error: "not_found" }, 404);
  }
  if (c.method === "PUT" && c.path.endsWith("/board")) {
    const b = boards.get(name);
    if (!b) return json({ error: "not_found" }, 404);
    if (q.get("expect_sha256") !== baseline(b).sha256)
      return json({ error: "conflict", ...baseline(b) }, 409);
    // PUT 的 body 是 JSON 文档；fakeFetch 已解析
    const next = { doc: c.body as CanvasDocJson, rev: b.rev + 1 };
    boards.set(name, next);
    return json({ baseline: baseline(next) });
  }
  if (c.method === "GET" && c.path.endsWith("/card")) {
    const card = cards.get(q.get("path") ?? "");
    if (!card) return json({ error: "not_found" }, 404);
    const b = baseline(card);
    return new Response(card.text, {
      headers: {
        "X-File-Mtime": String(b.mtimeMs),
        "X-File-Sha256": b.sha256,
      },
    });
  }
  if (c.method === "PATCH" && c.path.endsWith("/card")) {
    const from = q.get("path") ?? "";
    const card = cards.get(from);
    const board = boards.get("板");
    if (!card || !board) return json({ error: "not_found" }, 404);
    const to = `boards/板.cards/${(c.body as { name: string }).name}.md`;
    cards.delete(from);
    cards.set(to, card);
    boards.set("板", {
      doc: {
        ...board.doc,
        nodes: board.doc.nodes.map((n) =>
          n.file === from ? { ...n, file: to } : n,
        ),
      },
      rev: board.rev + 1,
    });
    return json({ path: to });
  }
  if (c.method === "DELETE" && c.path.endsWith("/asset")) {
    const path = q.get("path") ?? "";
    const b = boards.get("板");
    if (!b) return json({ error: "not_found" }, 404);
    boards.set("板", {
      doc: { ...b.doc, nodes: b.doc.nodes.filter((n) => n.file !== path) },
      rev: b.rev + 1,
    });
    return json({ ok: true });
  }
  if (c.method === "POST" && c.path.endsWith("/save")) {
    onSave?.();
    const body = c.body as {
      board: string;
      doc?: CanvasDocJson;
      expect?: { sha256?: string };
      edits: Array<{
        path: string;
        text: string;
        expect?: { sha256?: string };
      }>;
      created: Array<{ nodeId: string; text: string }>;
    };
    const b = boards.get(body.board);
    if (!b) return json({ error: "not_found" }, 404);
    if (body.doc && body.expect?.sha256 !== baseline(b).sha256)
      return json({ error: "conflict", ...baseline(b) }, 409);
    const out = {
      baseline: null as ReturnType<typeof baseline> | null,
      edits: [] as Array<{
        path: string;
        baseline: ReturnType<typeof baseline>;
      }>,
      created: [] as Array<{
        nodeId: string;
        path: string;
        baseline: ReturnType<typeof baseline>;
      }>,
      conflicts: [] as string[],
    };
    for (const e of body.edits) {
      const card = cards.get(e.path);
      if (!card) return json({ error: "not_found" }, 404);
      if (e.expect?.sha256 && e.expect.sha256 !== baseline(card).sha256) {
        out.conflicts.push(e.path);
        continue;
      }
      const next = { text: e.text, rev: card.rev + 1 };
      cards.set(e.path, next);
      out.edits.push({ path: e.path, baseline: baseline(next) });
    }
    const doc = body.doc ? structuredClone(body.doc) : null;
    for (const c2 of body.created) {
      const path = `boards/${body.board}.cards/新${++seq}.md`;
      const card = { text: c2.text, rev: 1 };
      cards.set(path, card);
      const n = doc?.nodes.find((x) => x.id === c2.nodeId);
      if (n) n.file = path;
      out.created.push({ nodeId: c2.nodeId, path, baseline: baseline(card) });
    }
    if (doc) {
      const next = { doc, rev: b.rev + 1 };
      boards.set(body.board, next);
      out.baseline = baseline(next);
    }
    return json(out);
  }
  return undefined;
};

beforeEach(() => {
  saveToken("tkn");
  localStorage.clear();
  calls = [];
  files = {};
  seq = 0;
  mediaRev = "aaaaaaaa";
  onSave = null;
  gate = null;
  cards = new Map();
  boards = new Map([
    ["板", { doc: { nodes: [node("a")], edges: [] }, rev: 1 }],
    ["另一块", { doc: { nodes: [], edges: [] }, rev: 1 }],
  ]);
  const stub = fakeFetch(calls, server);
  // 卡片正文的 PUT 带的是文本 body，fakeFetch 只认 JSON：这类请求在这里接住
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (!(init?.body instanceof Blob)) return stub(input, init);
    const url = new URL(input, "http://localhost");
    if (url.pathname.endsWith("/asset")) return uploadHandler(url, init.body);
    const text = await init.body.text();
    calls.push({
      method: init.method ?? "PUT",
      path: `${url.pathname}${url.search}`,
      body: text,
    });
    const path = url.searchParams.get("path") ?? "";
    const card = cards.get(path);
    if (!card) return json({ error: "not_found" }, 404);
    if (url.searchParams.get("expect_sha256") !== baseline(card).sha256)
      return json({ error: "conflict", ...baseline(card) }, 409);
    const next = { text, rev: card.rev + 1 };
    cards.set(path, next);
    return json({ baseline: baseline(next) });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// 资源上传：服务端传完就把节点放进画布文档（这里照样子做），大于 1MB 的拒绝；gate 能让上传停在半路
let gate: Promise<void> | null = null;
const uploadHandler = async (url: URL, body: Blob): Promise<Response> => {
  calls.push({
    method: "PUT",
    path: `${url.pathname}${url.search}`,
    body: { size: body.size },
  });
  if (gate) await gate;
  const q = url.searchParams;
  const name = q.get("name") ?? "";
  if (body.size > 1024 * 1024)
    return json({ error: "too_large", max: 1024 * 1024 }, 413);
  const b = boards.get(q.get("board") ?? "");
  if (!b) return json({ error: "not_found" }, 404);
  const path = `boards/${q.get("board")}.assets/${name}`;
  const n = {
    id: `asset-${++seq}`,
    type: "file",
    file: path,
    x: Number(q.get("x")),
    y: Number(q.get("y")),
    width: Number(q.get("w")),
    height: Number(q.get("h")),
  };
  boards.set(q.get("board") ?? "", {
    doc: { ...b.doc, nodes: [...b.doc.nodes, n] },
    rev: b.rev + 1,
  });
  return json({ path, nodeId: n.id, large: false, size: body.size }, 201);
};

const A = "boards/板.cards/a.md";
const make = () => createCanvasStore({ env: "local", dir: "/p" });
const saves = () =>
  calls.filter((c) => c.method === "POST" && c.path.includes("/save?"));
/** 第 n 次保存请求的内容 */
const sentBody = <T>(n = 0): T => {
  const c = saves()[n];
  if (!c) throw new Error("没有这次保存请求");
  return c.body as T;
};
const mirrorKeys = () =>
  Object.keys(localStorage).filter((k) => k.startsWith("ys.canvas.unsaved:"));
const docOf = (s: ReturnType<typeof make>) =>
  s.getSnapshot().doc as CanvasDocJson;
type Done = Extract<
  Awaited<ReturnType<ReturnType<typeof make>["saveAll"]>>,
  { kind: "done" }
>;
const done = async (s: ReturnType<typeof make>): Promise<Done> => {
  const r = await s.saveAll();
  if (r.kind !== "done") throw new Error(`保存失败：${r.message}`);
  return r;
};
/** 新卡片的占位名（节点 id → 占位名） */
const fileOfNode = (s: ReturnType<typeof make>, id: string) =>
  docOf(s).nodes.find((n) => n.id === id)?.file as string;

test("载入：要打开的画布在就打开它，不在就开第一块；一块都没有停在空态", async () => {
  const a = make();
  await a.init("另一块");
  expect(a.getSnapshot().board).toBe("另一块");

  const b = make();
  await b.init("不存在");
  expect(b.getSnapshot().board).toBe("板");

  boards.clear();
  const c = make();
  await c.init(null);
  expect(c.getSnapshot()).toMatchObject({ phase: "ready", board: null });
});

test("拖动只在本地生效，不会自己保存；保存时一个请求写出去，带着读出时的基线", async () => {
  const s = make();
  await s.init("板");
  const epoch = s.getSnapshot().epoch;
  s.commit({ ...docOf(s), nodes: [node("a", { x: 40, y: 50 })] });
  expect(s.getSnapshot()).toMatchObject({ layoutDirty: true });
  expect(isDirty(s.getSnapshot())).toBe(true);
  // 画布自己的拖动不重铺，否则拖到一半会被打断
  expect(s.getSnapshot().epoch).toBe(epoch);
  await new Promise((r) => setTimeout(r, 30));
  expect(saves()).toHaveLength(0);

  expect(await done(s)).toMatchObject({
    wrote: true,
    created: {},
    conflicts: [],
  });
  expect(saves()).toHaveLength(1);
  expect(sentBody<{ expect: { sha256: string } }>().expect.sha256).toBe(
    "1".padStart(64, "0"),
  );
  expect(s.getSnapshot()).toMatchObject({ layoutDirty: false, save: "idle" });
  expect(boards.get("板")?.doc.nodes[0]).toMatchObject({ x: 40, y: 50 });
  // 保存完不回读：除了这一次保存，没有别的请求
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
});

test("拖回原位：不算改动", async () => {
  const s = make();
  await s.init("板");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 40 })] });
  expect(s.getSnapshot().layoutDirty).toBe(true);
  s.commit({ ...docOf(s), nodes: [node("a")] });
  expect(isDirty(s.getSnapshot())).toBe(false);
});

test("没有改动时保存什么都不做", async () => {
  const s = make();
  await s.init("板");
  const before = calls.length;
  expect(await done(s)).toMatchObject({ wrote: false });
  expect(calls).toHaveLength(before);
});

test("保存时磁盘上的画布变了（agent 加了卡片）：以它为底合并再发一次，两边的改动都在，不丢也不报错", async () => {
  const s = make();
  await s.init("板");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 40, y: 50 })] });
  external("板", { nodes: [node("a"), node("agent", { x: 300 })], edges: [] });
  expect((await done(s)).wrote).toBe(true);

  const saved = boards.get("板")?.doc.nodes ?? [];
  expect(saved.map((n) => n.id)).toEqual(["a", "agent"]);
  expect(saved[0]).toMatchObject({ x: 40, y: 50 });
  expect(saves()).toHaveLength(2);
  expect(s.getSnapshot()).toMatchObject({ layoutDirty: false, save: "idle" });
  expect(docOf(s).nodes.map((n) => n.id)).toEqual(["a", "agent"]);
});

test("刷新：没有改动就整体换成磁盘上的版本；文档没变只更新卡片预览", async () => {
  const s = make();
  await s.init("板");
  const epoch = s.getSnapshot().epoch;

  files = { [A]: { exists: true, kind: "card", preview: "新内容" } };
  await s.refresh();
  expect(s.getSnapshot().epoch).toBe(epoch);
  expect(s.getSnapshot().files[A]?.preview).toBe("新内容");

  external("板", { nodes: [node("a"), node("agent")], edges: [] });
  await s.refresh();
  expect(s.getSnapshot().epoch).toBe(epoch + 1);
  expect(docOf(s).nodes).toHaveLength(2);
});

test("图片设置的指纹跟着载入与刷新走：文档没变时也更新（改设置不会改画布文件）", async () => {
  const s = make();
  await s.init("板");
  expect(s.getSnapshot().mediaRev).toBe("aaaaaaaa");
  mediaRev = "bbbbbbbb";
  await s.refresh();
  expect(s.getSnapshot().mediaRev).toBe("bbbbbbbb");
  mediaRev = "cccccccc";
  external("板", { nodes: [node("a"), node("agent")], edges: [] });
  await s.refresh();
  expect(s.getSnapshot().mediaRev).toBe("cccccccc");
});

test("addNodes：节点、连线与新卡片的正文都先攒在本地，保存时一次写出去", async () => {
  const s = make();
  await s.init("板");
  const fresh = newFile("p1");
  s.addNodes(
    [
      node("p1", { file: fresh, x: 400 }),
      {
        id: "l1",
        type: "link",
        url: "https://a.com",
        x: 0,
        y: 300,
        width: 320,
        height: 220,
      },
    ],
    [{ id: "e9", fromNode: "a", toNode: "p1" }],
    { [fresh]: "粘贴来的字" },
  );
  const snap = s.getSnapshot();
  expect(snap.doc?.nodes.map((n) => n.id)).toEqual(["a", "p1", "l1"]);
  expect(snap.doc?.edges).toHaveLength(1);
  expect(snap.edits[fresh]).toBe("粘贴来的字");
  expect(isDirty(snap)).toBe(true);
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);

  const r = await s.saveAll();
  expect(r.kind).toBe("done");
  const [path] = Object.values(r.kind === "done" ? r.created : {});
  expect(cards.get(path ?? "")?.text).toBe("粘贴来的字");
  expect(isDirty(s.getSnapshot())).toBe(false);
});

test("addNodes 要求选中时 pick 是新节点的 id，下一次重铺（刷新并进磁盘版本）自动清空", async () => {
  const s = make();
  await s.init("板");
  s.addNodes([node("p1", { file: newFile("p1") })], [], {}, true);
  expect(s.getSnapshot().pick).toEqual(["p1"]);
  s.addNodes([node("p2", { file: newFile("p2") })]);
  expect(s.getSnapshot().pick).toEqual([]);
  s.addNodes([node("p3", { file: newFile("p3") })], [], {}, true);
  external("板", { nodes: [node("a"), node("agent")], edges: [] });
  await s.refresh();
  expect(s.getSnapshot().pick).toEqual([]);
});

test("刷新时有没保存的拖动：磁盘版本并进来，拖动还在，也不会趁机替你保存", async () => {
  const s = make();
  await s.init("板");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 7 })] });
  external("板", { nodes: [node("a"), node("agent")], edges: [] });
  await s.refresh();
  const nodes = docOf(s).nodes;
  expect(nodes.map((n) => n.id)).toEqual(["a", "agent"]);
  expect(nodes[0]).toMatchObject({ x: 7 });
  expect(s.getSnapshot().layoutDirty).toBe(true);
  expect(saves()).toHaveLength(0);
});

test("放项目文件：本地立刻放上；磁盘上只多这一个节点，别的没保存的拖动不跟着写；同一个文件不重复放", async () => {
  const s = make();
  await s.init("板");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 9 })] });
  const epoch = s.getSnapshot().epoch;
  const id = s.addRef("../docs/a.md", { x: 10.4, y: 20 });
  expect(id).toMatch(/^[0-9a-f]{16}$/);
  // 外面加的节点画布自己不知道：要让画布重铺，否则拖进来的文件看不见
  expect(s.getSnapshot().epoch).toBe(epoch + 1);
  expect(s.addRef("../docs/a.md", { x: 0, y: 0 })).toBeNull();
  await s.refresh(); // 排在放文件之后，等它写完

  const onDisk = boards.get("板")?.doc.nodes ?? [];
  expect(onDisk.find((n) => n.file === "../docs/a.md")).toMatchObject({
    id,
    type: "file",
    x: 10,
    y: 20,
  });
  expect(onDisk.find((n) => n.id === "a")).toMatchObject({ x: 0 });
  // 本地的拖动还在，仍然算没保存
  expect(docOf(s).nodes.find((n) => n.id === "a")).toMatchObject({ x: 9 });
  expect(s.getSnapshot().layoutDirty).toBe(true);
});

test("放别的主机上的文件：节点带 host、file 是绝对路径并写进磁盘版本；同一主机同一路径不重复，换一台主机可以再放", async () => {
  const s = make();
  await s.init("板");
  const abs = "/srv/notes.md";
  const id = s.addRef(abs, { x: 0, y: 0 }, "dev");
  expect(id).toMatch(/^[0-9a-f]{16}$/);
  expect(s.addRef(abs, { x: 0, y: 0 }, "dev")).toBeNull();
  expect(s.addRef(abs, { x: 0, y: 0 }, "dev2")).toMatch(/^[0-9a-f]{16}$/);
  // 目录之内的同名相对路径是另一回事，不受影响
  expect(s.addRef(abs, { x: 0, y: 0 })).toMatch(/^[0-9a-f]{16}$/);
  await s.refresh();
  const onDisk = boards.get("板")?.doc.nodes ?? [];
  expect(onDisk.find((n) => n.id === id)).toMatchObject({
    type: "file",
    file: abs,
    host: "dev",
  });
  expect(onDisk.filter((n) => n.file === abs)).toHaveLength(3);
});

test("新卡片：可以同时有很多张，空的也算；只在本地，不请求服务端", async () => {
  const s = make();
  await s.init("板");
  const before = calls.length;
  const one = s.addCard({ x: 40, y: 80 });
  const two = s.addCard({ x: 300.4, y: 80 });
  expect(one).not.toBe(two);
  const files = [fileOfNode(s, one as string), fileOfNode(s, two as string)];
  expect(files.every(isNewFile)).toBe(true);
  expect(files[0]).toBe(newFile(one as string));
  // 一张都没写字，也是没保存的改动
  expect(s.getSnapshot()).toMatchObject({ layoutDirty: true, edits: {} });
  expect(isDirty(s.getSnapshot())).toBe(true);
  expect(docOf(s).nodes.find((n) => n.id === two)).toMatchObject({
    x: 300,
    y: 80,
  });
  expect(calls).toHaveLength(before);
});

test("保存新卡片：一个请求建出所有新卡片（空的也建），节点指向真文件，占位正文迁到真路径", async () => {
  const s = make();
  await s.init("板");
  const one = s.addCard({ x: 40, y: 80 }) as string;
  const two = s.addCard({ x: 400, y: 80 }) as string;
  const three = s.addCard({ x: 800, y: 80 }) as string;
  await s.loadCard(fileOfNode(s, one));
  s.setEdit(fileOfNode(s, one), "第一张");
  s.setEdit(fileOfNode(s, three), "第三张");
  const holders = [one, two, three].map((id) => fileOfNode(s, id));

  const r = await done(s);
  expect(saves()).toHaveLength(1);
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  expect(sentBody<{ created: unknown[] }>().created).toEqual([
    { nodeId: one, text: "第一张" },
    { nodeId: two, text: "" },
    { nodeId: three, text: "第三张" },
  ]);
  // 占位名 → 真路径
  expect(Object.keys(r.created)).toEqual(holders);
  const real = Object.values(r.created);
  expect(real.every((f) => !isNewFile(f))).toBe(true);
  expect(
    docOf(s).nodes.filter((n) => !isNewFile(n.file as string)),
  ).toHaveLength(4);
  expect([...cards.values()].map((c) => c.text).sort()).toEqual([
    "",
    "第一张",
    "第三张",
  ]);
  expect(s.getSnapshot().edits).toEqual({});
  expect(isDirty(s.getSnapshot())).toBe(false);
  // 预览已按写进去的内容更新，不用回读
  expect(
    s.getSnapshot().files[r.created[holders[0] as string] as string]?.preview,
  ).toBe("第一张");
  // 之后再改这张卡片，带着服务端给的基线
  const path = r.created[holders[0] as string] as string;
  await s.loadCard(path);
  s.setEdit(path, "第一张改了");
  expect((await done(s)).conflicts).toEqual([]);
  expect(cards.get(path)?.text).toBe("第一张改了");
});

test("新卡片可以连线：线连的是节点 id，保存后还在", async () => {
  const s = make();
  await s.init("板");
  const id = s.addCard({ x: 400, y: 0 }) as string;
  s.commit({
    ...docOf(s),
    edges: [{ id: "e1", fromNode: "a", toNode: id, fromSide: "right" }],
  });
  await done(s);
  expect(boards.get("板")?.doc.edges).toEqual([
    { id: "e1", fromNode: "a", toNode: id, fromSide: "right" },
  ]);
});

test("删掉没存过的新卡片：它的正文作废，删光了就不再算改动；服务端什么都没发生", async () => {
  const s = make();
  await s.init("板");
  const id = s.addCard({ x: 0, y: 400 }) as string;
  const file = fileOfNode(s, id);
  s.setEdit(file, "写了点字");
  expect(s.getSnapshot().edits).toEqual({ [file]: "写了点字" });
  const before = calls.length;
  s.commit(
    { ...docOf(s), nodes: docOf(s).nodes.filter((n) => n.id !== id) },
    true,
  );
  expect(s.getSnapshot().edits).toEqual({});
  expect(isDirty(s.getSnapshot())).toBe(false);
  expect(calls).toHaveLength(before);
});

test("保存期间又在新卡片里改了字：这部分仍是没保存的，挪到真路径下", async () => {
  const s = make();
  await s.init("板");
  const id = s.addCard({ x: 0, y: 400 }) as string;
  const ph = fileOfNode(s, id);
  s.setEdit(ph, "发出去的");
  onSave = () => s.setEdit(ph, "发出去的，又补了一句");
  const r = await done(s);
  const path = r.created[ph] as string;
  expect(cards.get(path)?.text).toBe("发出去的");
  expect(s.getSnapshot().edits).toEqual({ [path]: "发出去的，又补了一句" });
  expect(isDirty(s.getSnapshot())).toBe(true);
});

test("卡片正文：改了先攒着，改回原样就不算；保存一次写回，带着读出时的基线，预览同步更新", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  expect(await s.loadCard(A)).toEqual({ ok: true, data: "原文" });

  s.setEdit(A, "改了");
  expect(s.getSnapshot().edits).toEqual({ [A]: "改了" });
  expect(isDirty(s.getSnapshot())).toBe(true);
  s.setEdit(A, "原文");
  expect(s.getSnapshot().edits).toEqual({});
  expect(isDirty(s.getSnapshot())).toBe(false);

  s.setEdit(A, "改了");
  await new Promise((r) => setTimeout(r, 30));
  expect(saves()).toHaveLength(0);
  expect(await done(s)).toMatchObject({ wrote: true });
  expect(saves()).toHaveLength(1);
  const sent = sentBody<{
    doc?: unknown;
    edits: Array<{ path: string; expect: { sha256: string } }>;
  }>();
  expect(sent.doc).toBeUndefined();
  expect(sent.edits[0]?.expect.sha256).toBe(baseline({ rev: 1 }).sha256);
  expect(cards.get(A)?.text).toBe("改了");
  expect(s.getSnapshot().edits).toEqual({});
  expect(s.getSnapshot().files[A]?.preview).toBe("改了");

  // 保存之后基线前进了：再改回「原文」是新的改动
  s.setEdit(A, "原文");
  expect(s.getSnapshot().edits).toEqual({ [A]: "原文" });
});

test("再次打开编辑：有攒着的正文就接着改，不重新读服务端", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "改到一半");
  const reads = () => calls.filter((c) => c.path.includes("/card?")).length;
  const before = reads();
  expect(await s.loadCard(A)).toEqual({ ok: true, data: "改到一半" });
  expect(reads()).toBe(before);
});

test("读不出卡片：报错，不给空白（免得空白被存回去）", async () => {
  const s = make();
  await s.init("板");
  const r = await s.loadCard("boards/板.cards/没有.md");
  expect(r.ok).toBe(false);
});

test("布局、改过的卡片、新卡片的改动全部放进同一个请求", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "改了");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 5 })] });
  const id = s.addCard({ x: 0, y: 400 }) as string;
  s.setEdit(fileOfNode(s, id), "新的");
  calls.length = 0;

  expect((await done(s)).wrote).toBe(true);
  expect(
    calls.map(
      (c) => `${c.method} ${c.path.split("/canvas/local")[1]?.split("?")[0]}`,
    ),
  ).toEqual(["POST /save"]);
  const body = sentBody<{
    doc: { nodes: unknown[] };
    edits: unknown[];
    created: unknown[];
  }>();
  expect([
    body.doc.nodes.length,
    body.edits.length,
    body.created.length,
  ]).toEqual([2, 1, 1]);
  expect(isDirty(s.getSnapshot())).toBe(false);
});

test("卡片在别处被改过：这张不覆盖、正文留着，其余照常保存，结果里列出冲突的卡片", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "我的");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 5 })] });
  externalCard(A, "别处改的");

  const r = await done(s);
  expect(r.conflicts).toEqual([A]);
  expect(cards.get(A)?.text).toBe("别处改的");
  expect(s.getSnapshot().edits).toEqual({ [A]: "我的" });
  expect(s.getSnapshot().save).toBe("idle");
  expect(boards.get("板")?.doc.nodes[0]).toMatchObject({ x: 5 });

  // 选「覆盖」：用磁盘当前的基线写下去
  const disk = baseline({ rev: 2 });
  expect(await s.writeCard(A, "我的", disk)).toEqual({
    ok: true,
    data: undefined,
  });
  expect(cards.get(A)?.text).toBe("我的");
  expect(s.getSnapshot().edits).toEqual({});
});

test("冲突里选「用磁盘上的」：自己的改动丢掉，预览换成磁盘版本", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "我的");
  s.keepDisk(A, { text: "别处改的", base: baseline({ rev: 2 }) });
  expect(s.getSnapshot().edits).toEqual({});
  expect(s.getSnapshot().files[A]?.preview).toBe("别处改的");
});

test("保存失败（网络）：报错、保持没保存，改动都还在", async () => {
  const s = make();
  await s.init("板");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 5 })] });
  onSave = () => {
    throw new Error("断网");
  };
  const r = await s.saveAll();
  expect(r.kind).toBe("error");
  expect(s.getSnapshot().save).toBe("error");
  expect(s.getSnapshot().layoutDirty).toBe(true);
});

test("全部放弃：攒着的布局、正文、新卡片都作废，重新读磁盘，本地镜像也删掉", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "改了");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 5 })] });
  s.addCard({ x: 0, y: 400 });
  expect(mirrorKeys()).toHaveLength(1);

  expect((await s.discardAll()).ok).toBe(true);
  expect(isDirty(s.getSnapshot())).toBe(false);
  expect(docOf(s).nodes).toHaveLength(1);
  expect(docOf(s).nodes[0]).toMatchObject({ x: 0 });
  expect(saves()).toHaveLength(0);
  expect(mirrorKeys()).toEqual([]);
});

test("刷新时卡片已经被删：它攒着的正文跟着作废", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "改了");
  external("板", { nodes: [], edges: [] });
  await s.refresh();
  expect(s.getSnapshot().edits).toEqual({});
  expect(isDirty(s.getSnapshot())).toBe(false);
});

test("刷新时没存过的新卡片还在，它的正文也在", async () => {
  const s = make();
  await s.init("板");
  const id = s.addCard({ x: 0, y: 400 }) as string;
  const ph = fileOfNode(s, id);
  s.setEdit(ph, "新的");
  external("板", { nodes: [node("a"), node("agent")], edges: [] });
  await s.refresh();
  expect(docOf(s).nodes.map((n) => n.id)).toEqual(["a", "agent", id]);
  expect(s.getSnapshot().edits).toEqual({ [ph]: "新的" });
});

test("卡片改名：攒着的正文跟着新路径走，其余没保存的改动还在", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const s = make();
  await s.init("板");
  await s.loadCard(A);
  s.setEdit(A, "改了");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 5 })] });

  const r = await s.renameCard(A, "新名");
  const to = "boards/板.cards/新名.md";
  expect(r).toEqual({ ok: true, data: to });
  expect(s.getSnapshot().edits).toEqual({ [to]: "改了" });
  expect(docOf(s).nodes[0]).toMatchObject({ file: to, x: 5 });
  expect(s.getSnapshot().layoutDirty).toBe(true);

  // 改名之后接着编辑、保存：用的是改名前读到的基线
  s.setEdit(to, "又改了");
  expect(s.getSnapshot().edits).toEqual({ [to]: "又改了" });
  expect((await done(s)).conflicts).toEqual([]);
  expect(cards.get(to)?.text).toBe("又改了");
});

// ---- 本地镜像 ----

test("没保存的改动镜像进本地存储，保存后就删", async () => {
  const s = make();
  await s.init("板");
  expect(mirrorKeys()).toEqual([]);
  s.addCard({ x: 0, y: 400 });
  expect(mirrorKeys()).toHaveLength(1);
  await done(s);
  expect(mirrorKeys()).toEqual([]);
});

test("刷新页面后恢复：新卡片（含正文）、改过的卡片正文、拖动都回来，保存仍按原来的基线判冲突", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const before = make();
  await before.init("板");
  await before.loadCard(A);
  before.setEdit(A, "改了");
  before.commit({ ...docOf(before), nodes: [node("a", { x: 5 })] });
  const id = before.addCard({ x: 0, y: 400 }) as string;
  before.setEdit(fileOfNode(before, id), "新的");

  // 页面刷新：旧 store 没了，只剩本地存储
  const s = make();
  expect(await s.init("板")).toBe(true);
  expect(s.getSnapshot().edits).toEqual({
    [A]: "改了",
    [newFile(id)]: "新的",
  });
  expect(docOf(s).nodes.map((n) => n.id)).toEqual(["a", id]);
  expect(docOf(s).nodes[0]).toMatchObject({ x: 5 });
  expect(isDirty(s.getSnapshot())).toBe(true);
  // 原来开编辑时的基线也恢复了：这期间卡片被别处改过，保存时能发现
  externalCard(A, "别处改的");
  const r = await done(s);
  expect(r.conflicts).toEqual([A]);
  expect(cards.get(A)?.text).toBe("别处改的");
  expect(r.created[newFile(id)]).toBeDefined();
});

test("恢复时磁盘上的画布变过（agent 加了卡片）：以它为底合并，两边都在", async () => {
  const before = make();
  await before.init("板");
  before.commit({ ...docOf(before), nodes: [node("a", { x: 5 })] });
  before.addCard({ x: 0, y: 400 });
  external("板", { nodes: [node("a"), node("agent")], edges: [] });

  const s = make();
  expect(await s.init("板")).toBe(true);
  expect(
    docOf(s)
      .nodes.map((n) => n.id)
      .slice(0, 2),
  ).toEqual(["a", "agent"]);
  expect(docOf(s).nodes[0]).toMatchObject({ x: 5 });
  expect(docOf(s).nodes).toHaveLength(3);
});

test("恢复时卡片已经被删了：它的正文不恢复；什么都没剩就算没有可恢复的", async () => {
  cards.set(A, { text: "原文", rev: 1 });
  const before = make();
  await before.init("板");
  await before.loadCard(A);
  before.setEdit(A, "改了");
  external("板", { nodes: [], edges: [] });

  const s = make();
  expect(await s.init("板")).toBe(false);
  expect(s.getSnapshot().edits).toEqual({});
  expect(isDirty(s.getSnapshot())).toBe(false);
  expect(mirrorKeys()).toEqual([]);
});

test("换到别的画布：离开的那块没保存的镜像一并放弃（界面已确认），不会再恢复", async () => {
  const s = make();
  await s.init("板");
  s.addCard({ x: 0, y: 400 });
  expect(mirrorKeys()).toHaveLength(1);
  await s.open("另一块");
  expect(mirrorKeys()).toEqual([]);
  const again = make();
  expect(await again.init("板")).toBe(false);
});

test("镜像按 主机 + 目录 + 画布名 分开：别的目录的同名画布互不影响", async () => {
  const s = make();
  await s.init("板");
  s.addCard({ x: 0, y: 400 });
  const other = createCanvasStore({ env: "local", dir: "/q" });
  expect(await other.init("板")).toBe(false);
  expect(isDirty(other.getSnapshot())).toBe(false);
});

// ---- 粘贴 / 拖进来的文件 ----

const fileOf = (name: string, bytes = 10, type = "") =>
  new File([new Uint8Array(bytes)], name, { type });

test("上传文件：按类型给节点大小、中心落在 at 并依次错开，传完并回画布；剪贴板里的 image.png 换成带时间的名字", async () => {
  const s = make();
  await s.init("板");
  const r = await s.uploadAssets(
    [fileOf("方案.pdf"), fileOf("image.png", 20, "image/png"), fileOf("v.mp4")],
    { x: 500, y: 400 },
  );
  expect(r).toEqual({ placed: 3, failed: [] });
  const puts = calls.filter((c) => c.path.includes("/asset?"));
  expect(puts).toHaveLength(3);
  const qs = puts.map((c) => new URL(c.path, "http://x").searchParams);
  // pdf 240×96，居中在 (500,400)；png 320×240 错开 32；mp4 480×270 错开 64
  expect([
    qs[0]?.get("x"),
    qs[0]?.get("y"),
    qs[0]?.get("w"),
    qs[0]?.get("h"),
  ]).toEqual(["380", "352", "240", "96"]);
  expect([
    qs[1]?.get("x"),
    qs[1]?.get("y"),
    qs[1]?.get("w"),
    qs[1]?.get("h"),
  ]).toEqual(["372", "312", "320", "240"]);
  expect([qs[2]?.get("w"), qs[2]?.get("h")]).toEqual(["480", "270"]);
  expect(qs[1]?.get("name")).toMatch(/^粘贴-\d{8}-\d{6}\.png$/);
  expect(qs[0]?.get("name")).toBe("方案.pdf");
  expect(qs[0]?.get("board")).toBe("板");
  // 传完并回来：三个资源节点都在本地文档里，不算没保存的改动
  expect(
    docOf(s)
      .nodes.map((n) => n.file)
      .slice(1),
  ).toEqual([
    "boards/板.assets/方案.pdf",
    `boards/板.assets/${qs[1]?.get("name")}`,
    "boards/板.assets/v.mp4",
  ]);
  expect(s.getSnapshot()).toMatchObject({ layoutDirty: false, uploading: 0 });
});

test("上传期间 uploading 是剩下的个数（工具条据此显示），上传不占串行队列，期间可以保存", async () => {
  const s = make();
  await s.init("板");
  let release: () => void = () => {};
  gate = new Promise<void>((r) => {
    release = r;
  });
  const p = s.uploadAssets([fileOf("a.bin"), fileOf("b.bin")], { x: 0, y: 0 });
  await new Promise((r) => setTimeout(r, 10));
  expect(s.getSnapshot().uploading).toBe(2);
  // 上传还卡着，另一边照样能保存布局
  s.commit({ ...docOf(s), nodes: [node("a", { x: 9 })] });
  expect((await s.saveAll()).kind).toBe("done");
  release();
  expect(await p).toMatchObject({ placed: 2 });
  expect(s.getSnapshot().uploading).toBe(0);
});

test("上传时画布上有没保存的改动：并回来之后拖动与新卡片都还在，也不会被当成已保存", async () => {
  const s = make();
  await s.init("板");
  s.commit({ ...docOf(s), nodes: [node("a", { x: 7 })] });
  s.addCard({ x: 0, y: 400 });
  await s.uploadAssets([fileOf("p.png", 5, "image/png")], { x: 100, y: 100 });
  const nodes = docOf(s).nodes;
  expect(nodes[0]).toMatchObject({ id: "a", x: 7 });
  expect(nodes.some((n) => String(n.file).startsWith("::new:"))).toBe(true);
  expect(nodes.some((n) => n.file === "boards/板.assets/p.png")).toBe(true);
  expect(s.getSnapshot().layoutDirty).toBe(true);
  // 再保存：新卡片建出来，资源节点（服务端早就写了）不重复
  expect((await done(s)).wrote).toBe(true);
  expect(
    boards
      .get("板")
      ?.doc.nodes.filter((n) => n.file === "boards/板.assets/p.png"),
  ).toHaveLength(1);
});

test("上传失败：超过上限的说清上限，其余照常传；全失败时不去刷新", async () => {
  const s = make();
  await s.init("板");
  const r = await s.uploadAssets(
    [fileOf("big.bin", 2 * 1024 * 1024), fileOf("ok.bin")],
    { x: 0, y: 0 },
  );
  expect(r.placed).toBe(1);
  expect(r.failed).toEqual([
    { name: "big.bin", reason: "超过 1 MB 的上限（设置里可以调）" },
  ]);
  const before = calls.length;
  const none = await s.uploadAssets([fileOf("big.bin", 2 * 1024 * 1024)], {
    x: 0,
    y: 0,
  });
  expect(none.placed).toBe(0);
  // 只有那一次上传请求，没有多余的读取
  expect(calls.length - before).toBe(1);
});

test("删除资源走资源接口（不是卡片接口），文件与节点一起没有", async () => {
  const s = make();
  await s.init("板");
  await s.uploadAssets([fileOf("x.png", 5, "image/png")], { x: 0, y: 0 });
  const file = "boards/板.assets/x.png";
  expect((await s.deleteCards([file])).ok).toBe(true);
  const dels = calls.filter((c) => c.method === "DELETE");
  expect(dels).toHaveLength(1);
  expect(dels[0]?.path).toContain("/asset?");
  expect(docOf(s).nodes.some((n) => n.file === file)).toBe(false);
});

test("上传图片前先读出宽高比：节点放下来就是对的尺寸（不用载入后再校正，画布也不会变成未保存）；读不出就用默认大小", async () => {
  const s = make();
  await s.init("板");
  const bitmaps: Array<{ width: number; height: number } | "fail"> = [
    { width: 1600, height: 800 },
    "fail",
  ];
  vi.stubGlobal("createImageBitmap", async () => {
    const b = bitmaps.shift();
    if (b === "fail" || b === undefined) throw new Error("decode");
    return { ...b, close: () => {} };
  });
  await s.uploadAssets(
    [fileOf("wide.png", 5, "image/png"), fileOf("x.svg", 5, "image/svg+xml")],
    { x: 0, y: 0 },
  );
  const qs = calls
    .filter((c) => c.path.includes("/asset?"))
    .map((c) => new URL(c.path, "http://x").searchParams);
  expect([qs[0]?.get("w"), qs[0]?.get("h")]).toEqual(["320", "160"]);
  expect([qs[1]?.get("w"), qs[1]?.get("h")]).toEqual(["320", "240"]);
  expect(s.getSnapshot().layoutDirty).toBe(false);
});

test("preview：清单立刻按预演变；后台刷新不会把预演冲掉；settled 换成服务端的清单；revert 回到服务端那份；多个预演叠加", async () => {
  const st = make();
  await st.init(null);
  const names = () => st.getSnapshot().list?.boards.map((b) => b.name);
  expect(names()).toEqual(["板", "另一块"]);

  const p1 = st.preview((l) => previewRemove(l, ["板.canvas"]));
  expect(names()).toEqual(["另一块"]);
  // 后台刷新（服务端还没做，清单里还有「板」）：预演还叠在上面
  await st.refresh();
  expect(names()).toEqual(["另一块"]);
  // 再叠一个
  const p2 = st.preview((l) => previewRemove(l, ["另一块.canvas"]));
  expect(names()).toEqual([]);
  // 第二个失败：撤掉它，第一个仍在
  p2.revert();
  expect(names()).toEqual(["另一块"]);
  // 第一个服务端做完了（这里让假服务端真的删掉）：换成服务端的清单
  boards.delete("板");
  await p1.settled();
  expect(names()).toEqual(["另一块"]);
  // 失败的预演撤掉后回到服务端那份
  const p3 = st.preview((l) => previewRemove(l, ["另一块.canvas"]));
  expect(names()).toEqual([]);
  p3.revert();
  expect(names()).toEqual(["另一块"]);
});
