import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
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
import { EnvHub } from "../env/hub.js";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { FILE_READ_MAX, filesApi, parseRange } from "./files.js";

test("parseRange：单段区间、后缀、开放末端；多段与无效写法按无 Range", () => {
  expect(parseRange("bytes=1-3", 10)).toEqual({ start: 1, end: 3 });
  expect(parseRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
  expect(parseRange("bytes=5-99", 10)).toEqual({ start: 5, end: 9 });
  expect(parseRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
  expect(parseRange("bytes=-99", 10)).toEqual({ start: 0, end: 9 });
  expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
  expect(parseRange("bytes=4-2", 10)).toBe("unsatisfiable");
  expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
  expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
  expect(parseRange("items=0-1", 10)).toBeNull();
  expect(parseRange(undefined, 10)).toBeNull();
  expect(parseRange("bytes=0-1", 0)).toBeNull();
});

let sshd: TestSshd | null = null;
beforeAll(async () => {
  if (hasSshd) sshd = await startSshd();
});
afterAll(() => sshd?.close());

describe.each([
  ["local", true],
  ["ssh", hasSshd],
])("文件管理 API（%s 环境）", (kind, enabled) => {
  let root: string;
  let work: string;
  let db: Db;
  let hub: EnvHub;
  let audit: AuditLog;
  let app: FastifyInstance;
  let envId: string;

  beforeAll(async () => {
    if (!enabled) return;
    root = mkdtempSync(path.join(tmpdir(), "yuanshu-files-"));
    db = openDatabase(root);
    const secrets = new SecretStore(db, loadMasterKey(root));
    const environments = new EnvironmentStore(db);
    hub = new EnvHub(environments, secrets);
    audit = new AuditLog(db);
    envId = "local";
    if (kind === "ssh" && sshd) {
      const key = secrets.create("k", "ssh_key", sshd.privateKey);
      envId =
        environments.create({
          name: "t",
          host: "127.0.0.1",
          port: sshd.port,
          username: sshd.user,
          os: "posix",
          secretId: key?.id ?? null,
        })?.id ?? "";
    }
    app = Fastify();
    app.register(filesApi, { hub, audit });
    await app.ready();
  });
  afterAll(async () => {
    if (!enabled) return;
    await app.close();
    hub.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (!enabled) return;
    work = mkdtempSync(path.join(root, "w-"));
  });
  afterEach(() => {
    if (enabled) rmSync(work, { recursive: true, force: true });
  });

  const url = (op: string, q: Record<string, string> = {}) =>
    `/api/v1/environments/${envId}/files/${op}?${new URLSearchParams(q)}`;
  const get = (op: string, q: Record<string, string>, h = {}) =>
    app.inject({ method: "GET", url: url(op, q), headers: h });
  const put = (
    p: string,
    body: Buffer | string,
    q: Record<string, string> = {},
  ) =>
    app.inject({
      method: "PUT",
      url: url("content", { path: p, ...q }),
      headers: { "content-type": "application/octet-stream" },
      payload: body,
    });
  const post = (op: string, payload: object) =>
    app.inject({ method: "POST", url: url(op), payload });
  const del = (p: string, recursive = false) =>
    app.inject({
      method: "DELETE",
      url: url("entry", { path: p, ...(recursive ? { recursive: "1" } : {}) }),
    });
  const w = (...parts: string[]) => path.join(work, ...parts);

  describe.skipIf(!enabled)("读", () => {
    test("list：目录在前、隐藏文件由 hidden 控制、链接带目标且悬空标记 broken", async () => {
      writeFileSync(w("b.txt"), "bb");
      writeFileSync(w(".hid"), "h");
      mkdirSync(w("zdir"));
      symlinkSync(w("zdir"), w("link"));
      symlinkSync(w("nope"), w("dangling"));
      const r = await get("list", { path: work });
      expect(r.statusCode).toBe(200);
      const j = r.json();
      expect(j.path).toBe(work);
      expect(j.parent).toBe(path.dirname(work));
      expect(j.truncated).toBe(false);
      const by = Object.fromEntries(
        j.entries.map((e: { name: string }) => [e.name, e]),
      );
      expect(j.entries[0].name).toBe("link"); // link 指向目录，按目标算目录，排在 zdir 前（同为目录按名字）
      expect(j.entries[1].name).toBe("zdir");
      expect(by["b.txt"]).toMatchObject({ type: "file", size: 2 });
      expect(by.zdir.type).toBe("dir");
      expect(by.link).toMatchObject({ type: "dir", symlink: w("zdir") });
      expect(by.dangling).toMatchObject({
        type: "other",
        broken: true,
        symlink: w("nope"),
      });
      expect(by[".hid"]).toBeUndefined();
      expect(typeof by["b.txt"].mtimeMs).toBe("number");
      const all = await get("list", { path: work, hidden: "1" });
      expect(all.json().entries.map((e: { name: string }) => e.name)).toContain(
        ".hid",
      );
    });

    test("list/stat/content 的错误：相对路径 400、不存在 404、类型不符 400、环境未知 404", async () => {
      writeFileSync(w("f"), "x");
      expect((await get("list", { path: "rel" })).statusCode).toBe(400);
      expect((await get("list", {})).statusCode).toBe(400);
      expect((await get("list", { path: w("none") })).statusCode).toBe(404);
      expect((await get("list", { path: w("f") })).json().error).toBe(
        "not_a_directory",
      );
      expect((await get("stat", { path: w("none") })).statusCode).toBe(404);
      expect((await get("content", { path: work })).json().error).toBe(
        "not_a_file",
      );
      const r = await app.inject({
        method: "GET",
        url: `/api/v1/environments/nope/files/list?path=${encodeURIComponent(work)}`,
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe("env_not_found");
    });

    test("stat 返回单项描述", async () => {
      writeFileSync(w("f.txt"), "12345");
      const j = (await get("stat", { path: w("f.txt") })).json();
      expect(j).toMatchObject({
        path: w("f.txt"),
        name: "f.txt",
        type: "file",
        size: 5,
      });
    });

    test("content：按扩展名给 Content-Type；html/svg 加 sandbox，pdf 不加；全部 nosniff", async () => {
      const cases: Array<[string, string, boolean]> = [
        ["a.html", "text/html; charset=utf-8", true],
        ["a.svg", "image/svg+xml", true],
        ["a.pdf", "application/pdf", false],
        ["a.png", "image/png", false],
        ["a.md", "text/markdown; charset=utf-8", false],
        ["a.json", "application/json; charset=utf-8", false],
        ["a.xml", "text/plain; charset=utf-8", false],
        ["a.ts", "text/plain; charset=utf-8", false],
        ["Makefile", "text/plain; charset=utf-8", false],
        ["a.bin", "application/octet-stream", false],
      ];
      for (const [name, type, sandboxed] of cases) {
        writeFileSync(w(name), "<b>x</b>");
        const r = await get("content", { path: w(name) });
        expect(r.statusCode, name).toBe(200);
        expect(r.headers["content-type"], name).toBe(type);
        expect(r.headers["x-content-type-options"], name).toBe("nosniff");
        expect(r.headers["content-security-policy"], name).toBe(
          sandboxed ? "sandbox" : undefined,
        );
        expect(r.headers["accept-ranges"]).toBe("bytes");
        expect(r.body).toBe("<b>x</b>");
      }
    });

    test("content：as=text 强制纯文本；download=1 给附件头与八位组类型", async () => {
      writeFileSync(w("a.html"), "<b>x</b>");
      const t = await get("content", { path: w("a.html"), as: "text" });
      expect(t.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(t.headers["content-security-policy"]).toBeUndefined();
      const d = await get("content", { path: w("a.html"), download: "1" });
      expect(d.headers["content-type"]).toBe("application/octet-stream");
      expect(d.headers["content-disposition"]).toBe(
        "attachment; filename*=UTF-8''a.html",
      );
    });

    test("content：二进制与空文件原样返回", async () => {
      const bin = Buffer.from([0, 255, 10, 13, 200, 0]);
      writeFileSync(w("b.bin"), bin);
      writeFileSync(w("empty.txt"), "");
      expect(
        (await get("content", { path: w("b.bin") })).rawPayload.equals(bin),
      ).toBe(true);
      const e = await get("content", { path: w("empty.txt") });
      expect(e.statusCode).toBe(200);
      expect(e.body).toBe("");
    });

    test("Range：区间、后缀、开放末端返回 206；越界 416；多段忽略", async () => {
      writeFileSync(w("r.txt"), "0123456789");
      const rng = (v: string) =>
        get("content", { path: w("r.txt") }, { range: v });
      const a = await rng("bytes=2-4");
      expect(a.statusCode).toBe(206);
      expect(a.body).toBe("234");
      expect(a.headers["content-range"]).toBe("bytes 2-4/10");
      expect(a.headers["content-length"]).toBe("3");
      expect((await rng("bytes=-3")).body).toBe("789");
      expect((await rng("bytes=8-")).body).toBe("89");
      const bad = await rng("bytes=10-");
      expect(bad.statusCode).toBe(416);
      expect(bad.headers["content-range"]).toBe("bytes */10");
      const multi = await rng("bytes=0-1,4-5");
      expect(multi.statusCode).toBe(200);
      expect(multi.body).toBe("0123456789");
    });

    test("文本超过预览上限：截断在字符边界并带 X-Truncated，Range 取余下；下载不截断；二进制仅在 as=text 时截断", async () => {
      // "字" 占 3 字节，而上限不是 3 的倍数，截断点正好落在字符中间
      const text = "字".repeat(700_000);
      writeFileSync(w("big.txt"), text);
      const r = await get("content", { path: w("big.txt") });
      expect(r.statusCode).toBe(200);
      expect(r.headers["x-truncated"]).toBe("1");
      expect(r.headers["x-file-size"]).toBe("2100000");
      expect(r.rawPayload.length).toBe(2097150);
      expect(r.body).toBe("字".repeat(699_050));
      const rest = await get(
        "content",
        { path: w("big.txt") },
        { range: "bytes=2097150-" },
      );
      expect(rest.statusCode).toBe(206);
      expect(rest.body).toBe("字".repeat(950));
      expect(rest.headers["x-truncated"]).toBeUndefined();

      const full = await get("content", { path: w("big.txt"), download: "1" });
      expect(full.rawPayload.length).toBe(2_100_000);
      expect(full.headers["x-truncated"]).toBeUndefined();

      writeFileSync(w("big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
      const asText = await get("content", { path: w("big.bin"), as: "text" });
      expect(asText.headers["x-truncated"]).toBe("1");
      expect(asText.rawPayload.length).toBe(2 * 1024 * 1024);
    }, 30_000);

    test("超过上限的文件：整体读取 413，Range 仍可读", async () => {
      writeFileSync(w("big.bin"), "");
      truncateSync(w("big.bin"), FILE_READ_MAX + 1);
      const r = await get("content", { path: w("big.bin") });
      expect(r.statusCode).toBe(413);
      expect(r.json()).toMatchObject({
        error: "too_large",
        size: FILE_READ_MAX + 1,
      });
      const part = await get(
        "content",
        { path: w("big.bin") },
        { range: "bytes=0-9" },
      );
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.length).toBe(10);
    });
  });

  describe.skipIf(!enabled)("写", () => {
    test("上传：新建、冲突、overwrite 替换；二进制与大体积原样落盘，不留临时文件", async () => {
      const bin = Buffer.alloc(5 * 1024 * 1024 + 7, 0xab);
      bin[0] = 0;
      const r = await put(w("up.bin"), bin);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        path: w("up.bin"),
        size: bin.length,
        created: true,
      });
      expect(readFileSync(w("up.bin")).equals(bin)).toBe(true);

      const again = await put(w("up.bin"), "new");
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("exists");
      expect(readFileSync(w("up.bin")).equals(bin)).toBe(true);

      const over = await put(w("up.bin"), "new", { overwrite: "1" });
      expect(over.json()).toEqual({
        path: w("up.bin"),
        size: 3,
        created: false,
      });
      expect(readFileSync(w("up.bin"), "utf8")).toBe("new");
      expect(readdirSync(work)).toEqual(["up.bin"]);
    });

    test("上传：目标是目录 409，父目录不存在 404，空 body 得到空文件", async () => {
      mkdirSync(w("d"));
      expect((await put(w("d"), "x", { overwrite: "1" })).json().error).toBe(
        "is_directory",
      );
      const miss = await put(w("none", "f"), "x");
      expect(miss.statusCode).toBe(404);
      expect(miss.json().error).toBe("parent_missing");
      expect((await put(w("e.txt"), "")).statusCode).toBe(200);
      expect(readFileSync(w("e.txt")).length).toBe(0);
    });

    test("上传中途断开：不留临时文件，已存在的目标保持原样", async () => {
      writeFileSync(w("keep.txt"), "original");
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as net.AddressInfo;
      const sock = net.connect(port, "127.0.0.1");
      await new Promise<void>((ok) => sock.once("connect", ok));
      const target = encodeURIComponent(w("keep.txt"));
      sock.write(
        `PUT /api/v1/environments/${envId}/files/content?path=${target}&overwrite=1 HTTP/1.1\r\n` +
          `Host: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000000\r\n\r\n` +
          "x".repeat(4096),
      );
      await new Promise((ok) => setTimeout(ok, 200));
      sock.destroy();
      const deadline = Date.now() + 5000;
      while (readdirSync(work).length > 1 && Date.now() < deadline)
        await new Promise((ok) => setTimeout(ok, 50));
      expect(readdirSync(work)).toEqual(["keep.txt"]);
      expect(readFileSync(w("keep.txt"), "utf8")).toBe("original");
    });

    test("mkdir：逐级创建；已存在 409", async () => {
      const r = await post("mkdir", { path: w("a", "b") });
      expect(r.statusCode).toBe(201);
      expect(existsSync(w("a", "b"))).toBe(true);
      expect((await post("mkdir", { path: w("a", "b") })).statusCode).toBe(409);
      expect((await post("mkdir", { path: "rel" })).statusCode).toBe(400);
    });

    test("rename：移动；目标存在 409；overwrite 只替换文件，目录永不覆盖", async () => {
      writeFileSync(w("a"), "A");
      writeFileSync(w("b"), "B");
      mkdirSync(w("d"));
      expect(
        (await post("rename", { from: w("a"), to: w("c") })).statusCode,
      ).toBe(200);
      expect(readFileSync(w("c"), "utf8")).toBe("A");
      expect(existsSync(w("a"))).toBe(false);
      const clash = await post("rename", { from: w("c"), to: w("b") });
      expect(clash.statusCode).toBe(409);
      expect(
        (await post("rename", { from: w("c"), to: w("b"), overwrite: true }))
          .statusCode,
      ).toBe(200);
      expect(readFileSync(w("b"), "utf8")).toBe("A");
      writeFileSync(w("f"), "F");
      expect(
        (await post("rename", { from: w("f"), to: w("d"), overwrite: true }))
          .statusCode,
      ).toBe(409);
      expect(
        (await post("rename", { from: w("none"), to: w("x") })).statusCode,
      ).toBe(404);
    });

    test("delete：文件直接删；目录须 recursive；链接只删自身；根目录拒绝", async () => {
      writeFileSync(w("f"), "x");
      expect((await del(w("f"))).statusCode).toBe(204);
      expect(existsSync(w("f"))).toBe(false);

      mkdirSync(w("d", "sub"), { recursive: true });
      writeFileSync(w("d", "sub", "f"), "x");
      const need = await del(w("d"));
      expect(need.statusCode).toBe(400);
      expect(need.json().error).toBe("recursive_required");
      expect(existsSync(w("d", "sub", "f"))).toBe(true);
      expect((await del(w("d"), true)).statusCode).toBe(204);
      expect(existsSync(w("d"))).toBe(false);

      mkdirSync(w("keep"));
      writeFileSync(w("keep", "f"), "x");
      symlinkSync(w("keep"), w("ln"));
      expect((await del(w("ln"))).statusCode).toBe(204);
      expect(existsSync(w("keep", "f"))).toBe(true);

      expect((await del(w("none"))).statusCode).toBe(404);
      expect((await del("/", true)).statusCode).toBe(400);
    });

    test("写类操作记审计（actor=user, kind=file），读不记", async () => {
      await put(w("a.txt"), "payload-marker");
      await post("mkdir", { path: w("d") });
      await post("rename", { from: w("a.txt"), to: w("d", "a.txt") });
      await get("content", { path: w("d", "a.txt") });
      await del(w("d"), true);
      // 库在同一环境内的各用例间共享，只看本用例最新的 4 条
      const rows = audit.list({
        environment: envId,
        kind: "file",
        limit: 4,
      }).entries;
      expect(rows.map((r) => r.detail?.op)).toEqual([
        "delete",
        "rename",
        "mkdir",
        "write",
      ]);
      expect(rows.every((r) => r.actor === "user")).toBe(true);
      expect(rows[3]?.detail).toMatchObject({
        size: 14,
        created: true,
        target: w("a.txt"),
      });
      expect(
        rows.every(
          (r) =>
            r.detail?.result === "ok" &&
            typeof r.detail.durationMs === "number",
        ),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("payload-marker");
    });

    test("审计带会话归属；IO 失败也记 result=error", async () => {
      await put(w("a.txt"), "x", { sessionId: "s-9" });
      await post("mkdir", { path: w("d"), sessionId: "s-9" });
      const fail = await post("rename", {
        from: w("a.txt"),
        to: w("nope", "a.txt"),
        sessionId: "s-9",
      });
      expect(fail.statusCode).toBeGreaterThanOrEqual(400);
      const rm = await app.inject({
        method: "DELETE",
        url: url("entry", { path: w("d"), recursive: "1", sessionId: "s-9" }),
      });
      expect(rm.statusCode).toBe(204);
      const rows = audit.list({ session: "s-9", limit: 4 }).entries;
      expect(rows.map((r) => [r.detail?.op, r.detail?.result])).toEqual([
        ["delete", "ok"],
        ["rename", "error"],
        ["mkdir", "ok"],
        ["write", "ok"],
      ]);
      expect(rows.every((r) => r.sessionId === "s-9")).toBe(true);
      expect(rows[1]?.detail?.error).toBeTruthy();
    });
  });
});
