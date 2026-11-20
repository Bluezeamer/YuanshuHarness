import { afterEach, expect, test, vi } from "vitest";
import { flushLocal, localKey } from "../../../../app/localState";
import {
  dropFileDraft,
  isSensitivePath,
  loadFileDraft,
  stashFileDraft,
  sweepStaleFileDrafts,
} from "./fileDraft";

const base = { mtimeMs: 100, sha256: "abc" };

afterEach(() => {
  flushLocal();
  vi.useRealTimers();
});

test("暂存后能取回，带着开始编辑时的磁盘基线；读取会先把还在防抖里的写落下", () => {
  stashFileDraft("local", "/w/a.md", "改了一半", base);
  const d = loadFileDraft("local", "/w/a.md", "原文");
  expect(d?.text).toBe("改了一半");
  expect(d?.base).toEqual(base);
  expect(typeof d?.savedAt).toBe("number");
});

test("键是（主机，路径）：换主机或路径互不串", () => {
  stashFileDraft("local", "/w/a.md", "A", base);
  stashFileDraft("h1", "/w/a.md", "B", base);
  stashFileDraft("local", "/w/b.md", "C", base);
  expect(loadFileDraft("local", "/w/a.md", "")?.text).toBe("A");
  expect(loadFileDraft("h1", "/w/a.md", "")?.text).toBe("B");
  expect(loadFileDraft("local", "/w/b.md", "")?.text).toBe("C");
  expect(loadFileDraft("local", "/w/c.md", "")).toBeNull();
});

test("和磁盘内容一样的草稿没有意义：取的时候发现就删掉", () => {
  stashFileDraft("local", "/w/a.md", "一样", base);
  expect(loadFileDraft("local", "/w/a.md", "一样")).toBeNull();
  expect(loadFileDraft("local", "/w/a.md", "不一样")).toBeNull();
});

test("丢弃：保存、还原、放弃重载时删；防抖里还没落下的也不会又被写回", () => {
  vi.useFakeTimers();
  stashFileDraft("local", "/w/a.md", "x", base);
  dropFileDraft("local", "/w/a.md");
  vi.advanceTimersByTime(1000);
  expect(loadFileDraft("local", "/w/a.md", "")).toBeNull();
});

test("坏了的记录当没有", () => {
  const k = localKey("file.draft", "local", "/w/a.md");
  for (const raw of [
    "{oops",
    "null",
    '"x"',
    '{"text":1}',
    '{"text":"a","savedAt":1,"base":{"mtimeMs":"x","sha256":null}}',
  ]) {
    localStorage.setItem(k, raw);
    expect(loadFileDraft("local", "/w/a.md", "")).toBeNull();
  }
});

test("太大的不暂存，并且旧的草稿也不留（留着会恢复出过期内容）", () => {
  stashFileDraft("local", "/w/a.md", "旧", base);
  flushLocal();
  stashFileDraft("local", "/w/a.md", "大".repeat(1_100_000), base);
  expect(loadFileDraft("local", "/w/a.md", "")).toBeNull();
});

test("常见的密钥 / 环境文件不落本地（只是顺手的短名单，不是安全功能）", () => {
  for (const p of [
    "/w/.env",
    "/w/.env.production",
    "/home/u/.ssh/config",
    "/home/u/.ssh/id_rsa",
    "/w/id_ed25519",
    "/w/server.pem",
    "/w/tls.key",
  ])
    expect(isSensitivePath(p), p).toBe(true);
  for (const p of ["/w/a.md", "/w/environment.ts", "/w/keyboard.md"])
    expect(isSensitivePath(p), p).toBe(false);

  stashFileDraft("local", "/w/.env", "SECRET=1", base);
  flushLocal();
  expect(loadFileDraft("local", "/w/.env", "")).toBeNull();
  expect(
    Object.keys(localStorage).filter((k) => k.includes("file.draft")),
  ).toEqual([]);
});

test("启动清理：超过 30 天没动的草稿删掉，近的留着", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 3600_000;
  for (const [path, age] of [
    ["/w/old.md", 31],
    ["/w/new.md", 29],
  ] as const)
    localStorage.setItem(
      localKey("file.draft", "local", path),
      JSON.stringify({ text: "x", base, savedAt: now - age * day }),
    );
  sweepStaleFileDrafts(now);
  expect(loadFileDraft("local", "/w/old.md", "")).toBeNull();
  expect(loadFileDraft("local", "/w/new.md", "")?.text).toBe("x");
});
