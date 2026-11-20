// wrapDownload：等完成、查大小、存到 dest；取消要写控制台且幂等。全部用替身，不碰浏览器。
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { wrapDownload } from "./download.js";

const made = mkdtempSync(path.join(tmpdir(), "yuanshu-download-"));
afterAll(() => rmSync(made, { recursive: true, force: true }));

const LIMITS = { maxBytes: 1024, timeoutMs: 120_000 };

/** 替身 Download：本地先放一个源文件，path() 可选抛错 / 拖延，记录每个方法的调用次数。 */
function fakeDownload(
  body: string | null,
  opts: { pathError?: Error; pathHangs?: boolean; failure?: string } = {},
) {
  const src = path.join(made, `src-${Math.random().toString(16).slice(2)}`);
  if (body !== null) writeFileSync(src, body);
  const calls = { cancel: 0, delete: 0, saveAs: [] as string[] };
  return {
    calls,
    d: {
      suggestedFilename: () => "报表 2026.csv",
      url: () => "https://example.com/export?token=abc&x=1",
      path: () =>
        opts.pathError
          ? Promise.reject(opts.pathError)
          : opts.pathHangs
            ? new Promise<string>(() => {})
            : Promise.resolve(src),
      saveAs: async (dest: string) => {
        calls.saveAs.push(dest);
        writeFileSync(dest, body ?? "");
      },
      failure: async () => opts.failure ?? null,
      cancel: async () => {
        calls.cancel += 1;
      },
      delete: async () => {
        calls.delete += 1;
      },
    },
  };
}

const notes = () => {
  const out: string[] = [];
  return { out, note: (t: string) => void out.push(t) };
};

test("存成功：存到 dest 并返回字节数", async () => {
  const { calls, d } = fakeDownload("abcdef");
  const { out, note } = notes();
  const dest = path.join(made, "ok.csv");
  expect(await wrapDownload(d, note).saveTo(dest, LIMITS)).toBe(6);
  expect(calls.saveAs).toEqual([dest]);
  expect(statSync(dest).size).toBe(6);
  // saveAs 只是复制：浏览器自己的临时文件还在，不删就每个下载多占一份磁盘
  expect(calls.delete).toBe(1);
  expect(out).toEqual([]);
});

test("文件名与地址：地址里的令牌已打码", () => {
  const { d } = fakeDownload("x");
  const pd = wrapDownload(d, () => {});
  expect(pd.filename).toBe("报表 2026.csv");
  expect(pd.url).toBe("https://example.com/export?token=***&x=1");
});

test("超时：取消这次下载并抛中文错误，控制台留一条", async () => {
  const { calls, d } = fakeDownload(null, { pathHangs: true });
  const { out, note } = notes();
  const err = (await wrapDownload(d, note)
    .saveTo(path.join(made, "t.csv"), { maxBytes: 1024, timeoutMs: 50 })
    .catch((e: unknown) => e)) as Error;
  expect(err.message).toBe("下载超时（0.05 秒）");
  expect(calls.cancel).toBe(1);
  expect(out).toEqual(["已取消下载 报表 2026.csv：下载超时（0.05 秒）"]);
});

test("浏览器报失败：抛「下载失败：原因」，不取消也不存", async () => {
  const { calls, d } = fakeDownload("x", {
    failure: "net::ERR_CONNECTION_RESET",
  });
  const { out, note } = notes();
  const err = (await wrapDownload(d, note)
    .saveTo(path.join(made, "f.csv"), LIMITS)
    .catch((e: unknown) => e)) as Error;
  expect(err.message).toBe("下载失败：net::ERR_CONNECTION_RESET");
  expect(calls.saveAs).toEqual([]);
  expect(calls.cancel).toBe(0);
  expect(out).toEqual([]);
});

test("超过上限：删掉临时文件并抛「文件太大」", async () => {
  const { calls, d } = fakeDownload("x".repeat(2048));
  const { out, note } = notes();
  const err = (await wrapDownload(d, note)
    .saveTo(path.join(made, "big.csv"), LIMITS)
    .catch((e: unknown) => e)) as Error;
  expect(err.message).toBe("文件太大（2 KB，上限 1 KB）");
  expect(calls.delete).toBe(1);
  expect(calls.saveAs).toEqual([]);
  expect(out).toEqual([]);
});

test("cancel 写一条控制台，重复调用无副作用", async () => {
  const { calls, d } = fakeDownload("x");
  const { out, note } = notes();
  const pd = wrapDownload(d, note);
  await pd.cancel("用户没有批准");
  await pd.cancel("再来一次");
  expect(out).toEqual(["已取消下载 报表 2026.csv：用户没有批准"]);
  expect(calls.cancel).toBe(1);
});

test("已经存过之后再 cancel 无副作用", async () => {
  const { calls, d } = fakeDownload("abc");
  const { out, note } = notes();
  const pd = wrapDownload(d, note);
  await pd.saveTo(path.join(made, "saved.csv"), LIMITS);
  await pd.cancel("太晚了");
  expect(out).toEqual([]);
  expect(calls.cancel).toBe(0);
});

test("已取消之后 saveTo 抛错，不再动浏览器", async () => {
  const { calls, d } = fakeDownload("abc");
  const pd = wrapDownload(d, () => {});
  await pd.cancel("不要了");
  const err = (await pd
    .saveTo(path.join(made, "late.csv"), LIMITS)
    .catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("已取消");
  expect(calls.saveAs).toEqual([]);
});
