// 流式 zip 写入器：用 test/support/zip-read.ts 的小读取器核对结构与内容，能跑 unzip / python 时再交叉验一次。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { readZip } from "../../test/support/zip-read.js";
import { createZip, type ZipEntry } from "./zip-stream.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

const file = (
  name: string,
  data: Buffer,
  extra: { mode?: number; size?: number } = {},
): ZipEntry => ({
  name,
  size: extra.size ?? data.length,
  mtimeMs: Date.UTC(2024, 4, 6, 7, 8, 10),
  mode: extra.mode ?? 0o644,
  open: async () => Readable.from([data]),
});

const dir = (name: string, mode = 0o755): ZipEntry => ({
  name,
  dir: true,
  mtimeMs: Date.UTC(2024, 4, 6, 7, 8, 10),
  mode,
});

const zipOf = async (
  entries: AsyncIterable<ZipEntry>,
  opts?: { zip64Above?: number },
) => readZip(await collect(createZip(entries, opts)));

const has = (bin: string): boolean => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("zip 写入器", () => {
  test("文本、空文件、随机二进制（跨多个 chunk）都能原样读回", async () => {
    const text = Buffer.from("你好，世界\n".repeat(100));
    const random = Buffer.alloc(200 * 1024);
    for (let i = 0; i < random.length; i++) random[i] = (i * 7919) % 251;
    const { entries } = await zipOf(
      Readable.from([
        file("a.txt", text),
        file("empty.bin", Buffer.alloc(0)),
        file("rand.bin", random),
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual([
      "a.txt",
      "empty.bin",
      "rand.bin",
    ]);
    expect(entries[0]?.data.equals(text)).toBe(true);
    expect(entries[1]?.data.length).toBe(0);
    expect(entries[2]?.data.equals(random)).toBe(true);
  });

  test("中文与 emoji 文件名走 UTF-8；反斜杠统一成斜杠", async () => {
    const { entries } = await zipOf(
      Readable.from([
        file("中文 目录/文件 🎉.txt", Buffer.from("x")),
        file("a\\b\\c.txt", Buffer.from("y")),
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual([
      "中文 目录/文件 🎉.txt",
      "a/b/c.txt",
    ]);
    // 位 11：文件名是 UTF-8，否则解压工具按本地编码解读成乱码
    expect(entries.map((e) => e.flags & 0x0800)).toEqual([0x0800, 0x0800]);
  });

  test("目录条目以 / 结尾、不带数据；外部属性带 Unix mode", async () => {
    const { entries } = await zipOf(
      Readable.from([
        dir("top"),
        dir("top/sub"),
        file("top/sub/run.sh", Buffer.from("#!/bin/sh\n"), { mode: 0o755 }),
        file("top/secret.txt", Buffer.from("s"), { mode: 0o600 }),
      ]),
    );
    expect(entries.map((e) => [e.name, e.dir])).toEqual([
      ["top/", true],
      ["top/sub/", true],
      ["top/sub/run.sh", false],
      ["top/secret.txt", false],
    ]);
    expect(entries.map((e) => e.mode & 0o777)).toEqual([
      0o755, 0o755, 0o755, 0o600,
    ]);
    // 带文件类型位：目录 / 普通文件，解压器据此区分
    expect(entries.map((e) => e.mode & 0o170000)).toEqual([
      0o040000, 0o040000, 0o100000, 0o100000,
    ]);
  });

  test("时间用本地时区的 DOS 时间；早于 1980 的夹到 1980-01-01", async () => {
    const at = new Date(2024, 4, 6, 7, 8, 10);
    const old = new Date(1970, 0, 1);
    const entry = (name: string, when: Date): ZipEntry => ({
      name,
      dir: true,
      mtimeMs: when.getTime(),
      mode: 0o755,
    });
    const { entries } = await zipOf(
      Readable.from([entry("now", at), entry("old", old)]),
    );
    expect(entries[0]?.time).toEqual({
      year: at.getFullYear(),
      month: at.getMonth() + 1,
      day: at.getDate(),
    });
    expect(entries[1]?.time).toEqual({ year: 1980, month: 1, day: 1 });
  });

  test("size 与 open() 实际字节数不符时以实际读到的为准", async () => {
    const data = Buffer.from("actual payload");
    const { entries } = await zipOf(
      Readable.from([file("grown.txt", data, { size: 3 })]),
    );
    expect(entries[0]?.data.toString()).toBe("actual payload");
    expect(entries[0]?.size).toBe(data.length);
  });

  test("zip64：zip64Above 让小文件也走 zip64 写法，仍能读回", async () => {
    const big = Buffer.alloc(1024, 0x5a);
    const { entries, zip64 } = await zipOf(
      Readable.from([
        dir("d"),
        file("d/a.bin", big),
        file("d/empty", Buffer.alloc(0)),
      ]),
      { zip64Above: 10 },
    );
    // 条目数与偏移都没超，EOCD 仍是普通写法
    expect(zip64).toBe(false);
    expect(entries[1]?.data.equals(big)).toBe(true);
    expect(entries[1]?.size).toBe(1024);
    expect(entries[2]?.data.length).toBe(0);
  });

  test("条目数超过 65535 时 EOCD 走 zip64", async () => {
    const many = (async function* () {
      for (let i = 0; i < 70000; i++) yield dir(`d${i}`);
    })();
    const { entries, zip64 } = await zipOf(many);
    expect(zip64).toBe(true);
    expect(entries.length).toBe(70000);
    expect(entries[69999]?.name).toBe("d69999/");
  }, 60_000);

  // 路由里开始发流之后出错只能掐断连接：流本身必须以 error 结束，而不是默默结束成一只残 zip。
  test("源流出错时 zip 流也报错", async () => {
    const broken: ZipEntry = {
      name: "bad.bin",
      size: 1024,
      mtimeMs: 0,
      mode: 0o644,
      open: async () =>
        Readable.from(
          (async function* () {
            yield Buffer.alloc(16, 1);
            throw new Error("读盘失败");
          })(),
        ),
    };
    await expect(collect(createZip(Readable.from([broken])))).rejects.toThrow(
      "读盘失败",
    );
  });

  test("destroy 时正在打开的文件：打开完就关掉，不再读", async () => {
    let read = 0;
    let closed = 0;
    const src = Readable.from(
      (async function* () {
        for (;;) {
          read++;
          yield Buffer.alloc(1024, 1);
        }
      })(),
    );
    src.on("close", () => closed++);
    const entries = (async function* () {
      yield {
        name: "slow.bin",
        size: 1024,
        mtimeMs: 0,
        mode: 0o644,
        // open 本身很慢（ssh 开文件），期间消费方已经 destroy
        open: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return src;
        },
      } satisfies ZipEntry;
    })();
    const zip = createZip(entries);
    const reading = (async () => {
      for await (const c of zip) void c;
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    zip.destroy();
    await reading;
    await new Promise((r) => setTimeout(r, 400));
    expect(src.destroyed).toBe(true);
    expect(closed).toBe(1);
    expect(read).toBe(0);
  });

  test("提前 destroy：已打开的都关掉，后续条目不再 open", async () => {
    let opened = 0;
    let closed = 0;
    let yielded = 0;
    const entries = (async function* () {
      for (;;) {
        yielded++;
        yield {
          name: `f${yielded}.bin`,
          size: 64 * 1024,
          mtimeMs: 0,
          mode: 0o644,
          open: async () => {
            opened++;
            return Readable.from(
              (async function* () {
                try {
                  // 读不完的源：不掐断就会一直读下去
                  for (;;) {
                    await new Promise((r) => setTimeout(r, 1));
                    yield Buffer.alloc(1024, 1);
                  }
                } finally {
                  closed++;
                }
              })(),
            );
          },
        } satisfies ZipEntry;
      }
    })();
    const zip = createZip(entries);
    let got = 0;
    for await (const c of zip) {
      got += (c as Buffer).length;
      if (got > 4096) break;
    }
    zip.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(yielded).toBe(1);
  });

  // 读取器已经校验了 CRC 与大小，这里再用系统工具独立验一遍整份输出。
  test("unzip -t 与 python zipfile 能校验同一份输出", async (ctx) => {
    const unzip = has("unzip");
    const python = has("python3");
    if (!unzip || !python) ctx.skip();
    const buf = await collect(
      createZip(
        Readable.from([
          dir("pkg"),
          file("pkg/a.txt", Buffer.from("hello\n")),
          file("pkg/中文.txt", Buffer.from("世界\n")),
          file("pkg/deep/b.bin", Buffer.alloc(70 * 1024, 3)),
          file("pkg/empty", Buffer.alloc(0)),
        ]),
      ),
    );
    const zipPath = path.join(makeTmpDir("yuanshu-zip-"), "out.zip");
    writeFileSync(zipPath, buf);
    const test1 = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(test1).toContain("No errors detected");
    const count = execFileSync(
      "python3",
      [
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))",
        zipPath,
      ],
      { encoding: "utf8" },
    );
    expect(count.trim()).toBe("5");
  });
});
