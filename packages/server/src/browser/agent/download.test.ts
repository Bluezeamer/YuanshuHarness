// 工具层的下载处理：逐个审批、拒绝就取消、存成功给标记行、超出的报 dropped。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import type { PageDownload } from "../engine/types.js";
import type { Verdict } from "./approve.js";
import { isExecutableName, settleDownloads } from "./download.js";

const made = mkdtempSync(path.join(tmpdir(), "yuanshu-settle-"));
afterAll(() => rmSync(made, { recursive: true, force: true }));

function fakeDownload(
  name: string,
  opts: { fail?: string; body?: string } = {},
) {
  const cancelled: string[] = [];
  const saved: string[] = [];
  const d: PageDownload = {
    filename: name,
    url: `https://example.com/${name}?token=***`,
    async saveTo(dest) {
      if (opts.fail) throw new Error(opts.fail);
      const body = opts.body ?? `bytes of ${name}`;
      writeFileSync(dest, body);
      saved.push(dest);
      return Buffer.byteLength(body);
    },
    async cancel(reason) {
      cancelled.push(reason);
    },
  };
  return { d, cancelled, saved };
}

function ctx(
  patch: {
    approve?: (a: {
      filename: string;
      pageUrl: string;
      fileUrl: string;
      executable: boolean;
    }) => Promise<Verdict>;
    audit?: string[];
    maxBytes?: number;
  } = {},
) {
  const approved: Array<{
    filename: string;
    pageUrl: string;
    fileUrl: string;
    executable: boolean;
  }> = [];
  const savedFiles: Array<{ name: string; size: number }> = [];
  const audits: string[] = patch.audit ?? [];
  return {
    approved,
    savedFiles,
    audits,
    opts: {
      pageUrl: "https://example.com/list",
      approve: async (a: (typeof approved)[number]) => {
        approved.push(a);
        return patch.approve ? patch.approve(a) : ({ allowed: true } as const);
      },
      saveFile: async ({
        name,
        write,
      }: {
        name: string;
        write(abs: string): Promise<void>;
      }) => {
        const abs = path.join(made, `${savedFiles.length}-${name}`);
        await write(abs);
        const size = Buffer.byteLength(`bytes of ${name}`);
        savedFiles.push({ name, size });
        return {
          marker: `[attach_file] attachment:/d/${name} (text/csv, ${size} B)`,
          size,
          sizeText: `${size} B`,
        };
      },
      maxBytes: () => patch.maxBytes ?? 1024,
      audit: (summary: string) => void audits.push(summary),
    },
  };
}

test("存成功：给出带 [attach_file] 的两行，并写一条审计", async () => {
  const { d, saved } = fakeDownload("报表.csv");
  const c = ctx();
  const lines = await settleDownloads([d], 0, c.opts);
  expect(lines).toEqual([
    "Downloaded: 报表.csv (19 B) -> [attach_file] attachment:/d/报表.csv (text/csv, 19 B)\nRead it with the file tools or copy it into a working directory with transfer_files.",
  ]);
  expect(saved).toHaveLength(1);
  expect(c.audits).toEqual(["保存下载 报表.csv（19 B）"]);
});

test("用户拒绝：取消这次下载并告诉模型", async () => {
  const { d, cancelled, saved } = fakeDownload("a.zip");
  const c = ctx({
    approve: async () => ({ allowed: false, note: "别下这个" }),
  });
  const lines = await settleDownloads([d], 0, c.opts);
  expect(lines).toEqual([
    "用户没有批准下载 a.zip，已取消。\n用户补充：别下这个",
  ]);
  expect(cancelled).toEqual(["用户没有批准"]);
  expect(saved).toEqual([]);
  expect(c.audits).toEqual([]);
});

test("存失败：把 saveTo 的错误一行给模型", async () => {
  const { d } = fakeDownload("big.bin", {
    fail: "文件太大（2 KB，上限 1 KB）",
  });
  const c = ctx();
  const lines = await settleDownloads([d], 0, c.opts);
  expect(lines).toEqual(["下载 big.bin 失败：文件太大（2 KB，上限 1 KB）"]);
  expect(c.audits).toEqual([]);
});

test("dropped：多出来的下载在最后提示一句", async () => {
  const { d } = fakeDownload("a.zip");
  const c = ctx();
  const lines = await settleDownloads([d], 2, c.opts);
  expect(lines[1]).toBe(
    "这次动作还触发了 2 个下载，一次最多处理 3 个，其余已取消。",
  );
  // 一个都没收到、只 dropped 时也提示
  expect(await settleDownloads([], 1, ctx().opts)).toEqual([
    "这次动作还触发了 1 个下载，一次最多处理 3 个，其余已取消。",
  ]);
});

test("多个下载：逐个顺序审批（不并发出多张卡片）", async () => {
  const list = ["1.zip", "2.zip", "3.zip"].map((n) => fakeDownload(n));
  const order: string[] = [];
  const c = ctx({
    approve: async (a) => {
      order.push(`ask ${a.filename}`);
      return { allowed: true };
    },
  });
  const lines = await settleDownloads(
    list.map((x) => x.d),
    0,
    c.opts,
  );
  expect(order).toEqual(["ask 1.zip", "ask 2.zip", "ask 3.zip"]);
  expect(lines).toHaveLength(3);
});

test("可执行类扩展名传给 approve；地址超过 200 字符时截断加省略号", async () => {
  const long = `https://example.com/${"x".repeat(300)}.exe`;
  const { d } = fakeDownload("setup.exe");
  const c = ctx();
  await settleDownloads([{ ...d, url: long }], 0, {
    ...c.opts,
    pageUrl: `https://example.com/${"p".repeat(300)}`,
  });
  expect(c.approved[0]?.executable).toBe(true);
  expect(c.approved[0]?.filename).toBe("setup.exe");
  expect(c.approved[0]?.fileUrl).toHaveLength(201);
  expect(c.approved[0]?.fileUrl.endsWith("…")).toBe(true);
  expect(c.approved[0]?.pageUrl).toHaveLength(201);
});

test("isExecutableName：只看最后一个扩展名，大小写不敏感", () => {
  for (const name of [
    "a.exe",
    "A.EXE",
    "setup.Msi",
    "x.bat",
    "x.cmd",
    "x.com",
    "x.scr",
    "x.ps1",
    "x.vbs",
    "x.js",
    "x.jse",
    "x.wsf",
    "x.lnk",
    "x.reg",
    "x.sh",
    "x.jar",
    "x.app",
    "x.dmg",
    "x.pkg",
    "x.deb",
    "x.rpm",
    "x.apk",
  ])
    expect(isExecutableName(name), name).toBe(true);
  for (const name of ["a.txt", "a.pdf", "a.exe.txt", "exe", "a.zip", ""])
    expect(isExecutableName(name), name).toBe(false);
});
