// 转发出口的监听管理：端口分配、幂等、恢复、来源限制、关闭。
import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { HttpError } from "../lib/http-error.js";
import { type Db, openDatabase } from "../store/db.js";
import { type ForwardRow, ForwardStore } from "../store/forwards.js";
import type { ForwardHandler, ForwardTarget } from "./handler.js";
import {
  createForwardService,
  type ForwardService,
  type ForwardServiceDeps,
} from "./service.js";

const WORKSPACE = "w1";

interface Seen extends ForwardTarget {
  kind: "request" | "upgrade";
}

let db: Db;
let store: ForwardStore;
let seen: Seen[];
let svc: ForwardService | null = null;

const handler: ForwardHandler = {
  request(req, res, target) {
    seen.push({ kind: "request", ...target });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`ok ${req.url ?? ""}`);
  },
  upgrade(_req, socket, _head, target) {
    seen.push({ kind: "upgrade", ...target });
    socket.end();
  },
};

beforeEach(() => {
  db = openDatabase(makeTmpDir("yuanshu-forward-svc-"));
  store = new ForwardStore(db);
  seen = [];
  svc = null;
});

afterEach(async () => {
  await svc?.stop();
  db.close();
});

/** 找一段连续空闲的端口（先全都 listen 上确认没被占，再放开）。 */
async function freeRange(size: number): Promise<{ from: number; to: number }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    const servers: net.Server[] = [];
    let ok = true;
    for (let port = base; port < base + size; port++) {
      const s = net.createServer();
      const bound = await new Promise<boolean>((done) => {
        s.once("error", () => done(false));
        s.listen(port, "127.0.0.1", () => done(true));
      });
      if (!bound) {
        s.close();
        ok = false;
        break;
      }
      servers.push(s);
    }
    for (const s of servers)
      await new Promise<void>((done) => s.close(() => done()));
    if (ok) return { from: base, to: base + size - 1 };
  }
  throw new Error("找不到空闲端口段");
}

const make = (over: Partial<ForwardServiceDeps> = {}): ForwardService =>
  createForwardService({
    store,
    handler,
    range: { from: 7500, to: 7509 },
    host: "127.0.0.1",
    allowCidrs: [],
    allow: () => true,
    serverPort: () => null,
    ...over,
  });

/** 连得上就算在监听：返回一句正文，连不上返回 null。 */
async function probe(port: number): Promise<string | null> {
  return new Promise((ok) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/x", timeout: 1000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => ok(body));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => ok(null));
  });
}

/** 占住一个端口，返回释放函数。 */
async function occupy(port: number): Promise<() => Promise<void>> {
  const s = net.createServer();
  await new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));
  return () => new Promise<void>((ok) => s.close(() => ok()));
}

const row = (over: Partial<ForwardRow> = {}): ForwardRow => ({
  id: "old",
  workspaceKey: WORKSPACE,
  envId: "e1",
  port: 3000,
  localPort: 7501,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

test("open：拿到范围内最小的空闲端口并真的在监听", async () => {
  const range = await freeRange(3);
  svc = make({ range });
  const view = await svc.open(WORKSPACE, "e1", 3000);
  expect(view).toEqual({
    id: expect.any(String),
    envId: "e1",
    port: 3000,
    localPort: range.from,
    listening: true,
  });
  expect(await probe(range.from)).toBe("ok /x");
  // 请求按库里的目标交给 handler
  expect(seen).toEqual([{ kind: "request", envId: "e1", port: 3000 }]);
  expect(store.get(view.id)).toMatchObject({
    workspaceKey: WORKSPACE,
    envId: "e1",
    port: 3000,
    localPort: range.from,
  });
});

test("open 幂等：同参数再来一次返回同一条，不重复监听", async () => {
  const range = await freeRange(3);
  svc = make({ range });
  const first = await svc.open(WORKSPACE, "e1", 3000);
  const again = await svc.open(WORKSPACE, "e1", 3000);
  expect(again).toEqual(first);
  expect(store.all()).toHaveLength(1);
  expect(await probe(range.from)).toBe("ok /x");
  expect(await probe(range.from)).toBe("ok /x");
  // 两个请求都由同一个出口处理（端口没变），没有重复监听
  expect(seen).toHaveLength(2);
});

test("并发 open 同一目标（双击）：只开一个监听、只落一条记录，两次返回同一条", async () => {
  svc = make();
  const [a, b] = await Promise.all([
    svc.open(WORKSPACE, "e1", 3000),
    svc.open(WORKSPACE, "e1", 3000),
  ]);
  expect(b).toEqual(a);
  expect(store.all()).toHaveLength(1);
  // 范围里别的端口都没被孤儿监听占着
  const taken = [];
  for (let p = 7500; p <= 7509; p++)
    if ((await probe(p)) !== null) taken.push(p);
  expect(taken).toEqual([a.localPort]);
});

test("open：两条转发拿不同端口，list 按工作区给出", async () => {
  const range = await freeRange(4);
  svc = make({ range });
  const a = await svc.open(WORKSPACE, "e1", 3000);
  const b = await svc.open(WORKSPACE, "e1", 3001);
  expect(a.localPort).toBe(range.from);
  expect(b.localPort).toBe(range.from + 1);
  expect(svc.list(WORKSPACE)).toEqual([a, b]);
  expect(svc.list("w2")).toEqual([]);
});

test("open：监听掉了的记录会被重新监听", async () => {
  const range = await freeRange(2);
  svc = make({ range });
  // 库里已有记录，但这轮还没起监听（相当于上次监听意外掉了）
  store.insert(row({ localPort: range.from }));
  const view = await svc.open(WORKSPACE, "e1", 3000);
  expect(view).toEqual({
    id: "old",
    envId: "e1",
    port: 3000,
    localPort: range.from,
    listening: true,
  });
  expect(await probe(range.from)).toBe("ok /x");
});

test("close：端口释放、记录删除；别的工作区关不掉", async () => {
  const range = await freeRange(2);
  svc = make({ range });
  const view = await svc.open(WORKSPACE, "e1", 3000);
  expect(await svc.close("w2", view.id)).toBe(false);
  expect(await probe(range.from)).toBe("ok /x");
  expect(await svc.close(WORKSPACE, view.id)).toBe(true);
  expect(await probe(range.from)).toBeNull();
  expect(store.get(view.id)).toBeNull();
  expect(await svc.close(WORKSPACE, view.id)).toBe(false);
});

test("分配要避开库里已有的出口端口（监听停掉之后也算占着）", async () => {
  const range = await freeRange(3);
  svc = make({ range });
  const a = await svc.open(WORKSPACE, "e1", 3000);
  await svc.stop();
  const b = await svc.open(WORKSPACE, "e1", 3001);
  expect(b.localPort).not.toBe(a.localPort);
  expect(
    store
      .all()
      .map((r) => r.localPort)
      .sort(),
  ).toEqual([a.localPort, b.localPort].sort());
});

test("restore：新 service 用同一个库把老端口重新监听起来", async () => {
  const range = await freeRange(3);
  svc = make({ range });
  const view = await svc.open(WORKSPACE, "e1", 3000);
  await svc.stop();
  svc = null;

  const again = make({ range });
  svc = again;
  expect(again.list(WORKSPACE)).toEqual([{ ...view, listening: false }]);
  await again.restore();
  expect(again.list(WORKSPACE)).toEqual([{ ...view, listening: true }]);
  expect(await probe(range.from)).toBe("ok /x");
});

test("restore：端口被别人占了就保留记录、listening=false", async () => {
  const range = await freeRange(2);
  store.insert(row({ localPort: range.from }));
  const release = await occupy(range.from);
  try {
    svc = make({ range });
    await svc.restore();
    expect(svc.list(WORKSPACE)).toMatchObject([
      { localPort: range.from, listening: false },
    ]);
    expect(store.all()).toHaveLength(1);
  } finally {
    await release();
  }
});

test("分配跳过被占的端口；全都占满就用尽 409", async () => {
  const range = await freeRange(2);
  const release = await occupy(range.from);
  try {
    svc = make({ range });
    expect((await svc.open(WORKSPACE, "e1", 3000)).localPort).toBe(range.to);
    // 剩下那个端口被占用、这个又被上面那条拿去：没有可用的了
    await expect(svc.open(WORKSPACE, "e1", 3001)).rejects.toMatchObject({
      code: "range_exhausted",
      status: 409,
    });
  } finally {
    await release();
  }
});

test("分配跳过 Server 自己的端口", async () => {
  const range = await freeRange(2);
  svc = make({ range, serverPort: () => range.from });
  const view = await svc.open(WORKSPACE, "e1", 3000);
  expect(view.localPort).toBe(range.to);
});

test("范围全被占：range_exhausted 409，正文写明范围", async () => {
  const range = await freeRange(1);
  const release = await occupy(range.from);
  try {
    svc = make({ range });
    await expect(svc.open(WORKSPACE, "e1", 3000)).rejects.toThrow(HttpError);
    await expect(svc.open(WORKSPACE, "e1", 3000)).rejects.toMatchObject({
      code: "range_exhausted",
      status: 409,
      message: `转发端口用完了（${range.from}-${range.to}），先关掉不用的转发`,
    });
    expect(store.all()).toEqual([]);
  } finally {
    await release();
  }
});

test("allow 为假：403，且一个端口都没监听", async () => {
  const range = await freeRange(2);
  svc = make({ range, allow: () => false });
  await expect(svc.open(WORKSPACE, "e1", 3000)).rejects.toMatchObject({
    code: "forbidden_target",
    status: 403,
  });
  expect(store.all()).toEqual([]);
  expect(await probe(range.from)).toBeNull();
});

test("把转发端口当目标：403", async () => {
  const range = await freeRange(3);
  svc = make({ range });
  await svc.open(WORKSPACE, "e1", 3000);
  // 范围内的端口不论有没有被分配出去都不许当目标
  for (const port of [range.from, range.from + 2]) {
    await expect(svc.open(WORKSPACE, "e2", port)).rejects.toMatchObject({
      code: "forbidden_target",
      status: 403,
    });
  }
  expect(store.all()).toHaveLength(1);
});

test("来源网段：回环放行，别的网段连不上", async () => {
  const range = await freeRange(2);
  svc = make({ range, allowCidrs: ["127.0.0.0/8"] });
  const ok = await svc.open(WORKSPACE, "e1", 3000);
  expect(await probe(ok.localPort)).toBe("ok /x");
  await svc.stop();

  // 换成不含回环的网段：端口在监听，但连接一进来就被断开
  svc = make({ range, allowCidrs: ["192.0.2.0/24"] });
  await svc.restore();
  expect(svc.list(WORKSPACE)).toMatchObject([{ listening: true }]);
  expect(await probe(ok.localPort)).toBeNull();
  expect(seen).toEqual([{ kind: "request", envId: "e1", port: 3000 }]);
});

test("来源网段：连上来就被直接断开，不给任何回应", async () => {
  const range = await freeRange(1);
  svc = make({ range, allowCidrs: ["192.0.2.0/24"] });
  const view = await svc.open(WORKSPACE, "e1", 3000);
  const socket = net.connect({ host: "127.0.0.1", port: view.localPort });
  // 没有被接受：要么连接被重置，要么读不到任何字节就结束
  const outcome = await new Promise<string>((done) => {
    let bytes = 0;
    socket.on("data", (c) => {
      bytes += c.length;
    });
    socket.on("error", () => done("error"));
    // 静默断开：可能先 close（FIN）也可能直接重置，两种都算拒绝，只要一个字节都没回
    socket.on("close", () =>
      done(bytes === 0 ? "closed" : "closed-with-bytes"),
    );
  });
  socket.destroy();
  expect(["closed", "error"]).toContain(outcome);
  expect(seen).toEqual([]);
});

test("stop：全部关闭，端口都不再监听", async () => {
  const range = await freeRange(4);
  svc = make({ range });
  const a = await svc.open(WORKSPACE, "e1", 3000);
  const b = await svc.open(WORKSPACE, "e1", 3001);
  await svc.stop();
  expect(await probe(a.localPort)).toBeNull();
  expect(await probe(b.localPort)).toBeNull();
  expect(svc.list(WORKSPACE).map((v) => v.listening)).toEqual([false, false]);
});
