// 上传来源的解析与硬边界：每条拒绝分支一个用例，全部用真的本机环境与真文件系统。
// 位置按会话的位置规则解析（session/address.ts，host + path），这里用真的地址簿驱动。
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { LocalEnv } from "../../env/local.js";
import { VirtualEnv } from "../../env/virtual.js";
import { makeAddressBook } from "../../session/address-testkit.js";
import type { Directory } from "../../store/directories.js";
import {
  readUploadSource,
  resolveUploadFile,
  UPLOAD_MAX_FILES,
} from "./upload.js";

const local = new LocalEnv();
const tmp = () => makeTmpDir("yuanshu-upload-");

function dir(
  name: string,
  p: string,
  opts: { id?: string; environmentId?: string } = {},
): Directory {
  return {
    id: opts.id ?? name,
    name,
    path: p,
    environmentId: opts.environmentId ?? "local",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 工作区 + 附件区两个 directory；两者都是本机文件（附件区是虚拟主机）。 */
function setup() {
  const work = tmp();
  const attach = tmp();
  const all = [
    dir("项目", work, { id: "w1" }),
    dir("attachment", attach, { id: "att", environmentId: "attachment" }),
  ];
  const book = makeAddressBook({
    dirs: all,
    currentId: "w1",
    primaryId: "w1",
    envOf: (d) =>
      d.environmentId === "attachment" ? new VirtualEnv(d.path) : local,
  });
  return {
    work,
    attach,
    all,
    deps: {
      locate: (h: string | undefined, p: string | undefined) =>
        book.locate(h, p),
    },
  };
}

const MAX = 1024;

test("正常：相对路径解析到工作区内的文件，名字与大小对，display 是 host:绝对路径", async () => {
  const s = setup();
  const body = Buffer.from("上传内容");
  writeFileSync(path.join(s.work, "报告.txt"), body);
  const r = await resolveUploadFile(s.deps, undefined, "报告.txt", MAX);
  expect(r.name).toBe("报告.txt");
  expect(r.size).toBe(body.length);
  expect(r.display).toBe(`local:${path.join(s.work, "报告.txt")}`);
  const chunks: Buffer[] = [];
  for await (const c of await r.open()) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).equals(body)).toBe(true);
});

test("地址形式与子目录：display 用 host:绝对路径", async () => {
  const s = setup();
  mkdirSync(path.join(s.work, "sub"));
  writeFileSync(path.join(s.work, "sub", "a.txt"), "a");
  const abs = path.join(s.work, "sub", "a.txt");
  const r = await resolveUploadFile(s.deps, "local", abs, MAX);
  expect(r.display).toBe(`local:${abs}`);
});

test("附件区里的文件可以上传，display 不暴露真实路径", async () => {
  const s = setup();
  mkdirSync(path.join(s.attach, "2026-11-16"), { recursive: true });
  writeFileSync(path.join(s.attach, "2026-11-16", "用户贴的.csv"), "x,y");
  const r = await resolveUploadFile(
    s.deps,
    "attachment",
    "/2026-11-16/用户贴的.csv",
    MAX,
  );
  expect(r.display).toBe("attachment:/2026-11-16/用户贴的.csv");
  expect(r.name).toBe("用户贴的.csv");
});

test("符号链接指到外面：realpath 之后不在归属目录内，拒绝", async () => {
  const s = setup();
  const outside = tmp();
  writeFileSync(path.join(outside, "secret.txt"), "s");
  symlinkSync(path.join(outside, "secret.txt"), path.join(s.work, "link.txt"));
  const err = (await resolveUploadFile(
    s.deps,
    undefined,
    "link.txt",
    MAX,
  ).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain('not inside its directory "项目"');
});

test("敏感名：.env 与 .ssh/id_rsa 都拒绝", async () => {
  const s = setup();
  writeFileSync(path.join(s.work, ".env"), "K=v");
  mkdirSync(path.join(s.work, ".ssh"));
  writeFileSync(path.join(s.work, ".ssh", "id_rsa"), "key");
  for (const p of [".env", path.join(".ssh", "id_rsa")]) {
    const err = (await resolveUploadFile(s.deps, undefined, p, MAX).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain("secret or credential file");
  }
});

test("`..` 越界：realpath 之后不在归属目录内，拒绝", async () => {
  const s = setup();
  const outside = tmp();
  writeFileSync(path.join(outside, "out.txt"), "o");
  const err = (await resolveUploadFile(
    s.deps,
    undefined,
    path.join("..", path.basename(outside), "out.txt"),
    MAX,
  ).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("not inside its directory");
});

test("目录不是普通文件：拒绝", async () => {
  const s = setup();
  mkdirSync(path.join(s.work, "folder"));
  const err = (await resolveUploadFile(s.deps, undefined, "folder", MAX).catch(
    (e: unknown) => e,
  )) as Error;
  expect(err.message).toContain("Only regular files can be uploaded");
});

test("超过上限：拒绝并说清大小与上限", async () => {
  const s = setup();
  writeFileSync(path.join(s.work, "big.bin"), Buffer.alloc(2048));
  const err = (await resolveUploadFile(
    s.deps,
    undefined,
    "big.bin",
    1024,
  ).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("File too large (2 KB, limit 1 KB)");
});

test("不存在：拒绝", async () => {
  const s = setup();
  const err = (await resolveUploadFile(
    s.deps,
    undefined,
    "nope.txt",
    MAX,
  ).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("File not found");
});

test("主机不可用：拒绝", async () => {
  const s = setup();
  const bad = dir("远端", "/srv/x", { id: "remote", environmentId: "remote" });
  const book = makeAddressBook({
    dirs: [...s.all, bad],
    currentId: "remote",
    primaryId: "w1",
    envOf: (d) =>
      d.environmentId === "attachment"
        ? new VirtualEnv(d.path)
        : d.environmentId === "local"
          ? local
          : null,
  });
  const err = (await resolveUploadFile(
    { locate: (h, p) => book.locate(h, p) },
    undefined,
    "a.txt",
    MAX,
  ).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain('Host "remote" is not available.');
});

test("未知主机：拒绝（地址解析的报错原样给出）", async () => {
  const s = setup();
  const err = (await resolveUploadFile(s.deps, "ghost", "/a.txt", MAX).catch(
    (e: unknown) => e,
  )) as Error;
  expect(err.message).toContain('Unknown host "ghost"');
});

test("host 与 path 分开：点名目录时相对路径从它起", async () => {
  const s = setup();
  writeFileSync(path.join(s.work, "a.txt"), "a");
  const r = await resolveUploadFile(s.deps, "local:项目", "a.txt", MAX);
  expect(r.display).toBe(`local:${path.join(s.work, "a.txt")}`);
});

test("一次最多 5 个文件", () => {
  expect(UPLOAD_MAX_FILES).toBe(5);
});

// —— 读进内存 ——

/** 造一个大小已声明、读流按需给内容的来源。 */
function source(
  name: string,
  body: Buffer | (() => Readable),
  size = Buffer.isBuffer(body) ? body.length : 0,
) {
  return {
    name,
    size,
    open: async () =>
      typeof body === "function" ? body() : Readable.from([body]),
  };
}

test("readUploadSource：读完得到全部字节", async () => {
  const body = Buffer.from([0, 1, 255, 2]);
  expect(
    (await readUploadSource(source("a.bin", body), 1024)).equals(body),
  ).toBe(true);
});

test("readUploadSource：超过 limit 立刻中止，不读完整个流", async () => {
  let produced = 0;
  const endless = source("big.bin", () =>
    Readable.from(
      (function* () {
        for (let i = 0; i < 1000; i++) {
          produced += 1;
          yield Buffer.alloc(16, 1);
        }
      })(),
    ),
  );
  const err = (await readUploadSource(endless, 64).catch(
    (e: unknown) => e,
  )) as Error;
  expect(err.message).toContain("File too large (read more than 64 B)");
  expect(err.message).toContain("big.bin");
  // 1000 块共 16000 字节，超限后不该再继续读
  expect(produced).toBeLessThan(1000);
});

test("readUploadSource：读流抛错原样抛出", async () => {
  const bad = source("bad.bin", () =>
    Readable.from(
      (function* () {
        yield Buffer.from("head");
        throw new Error("远端连接断了");
      })(),
    ),
  );
  const err = (await readUploadSource(bad, 1024).catch(
    (e: unknown) => e,
  )) as Error;
  expect(err.message).toBe("远端连接断了");
});
