// presentBody：文本判定（能不能解成 UTF-8）、预览上限、附件与遮罩、大小上限、扩展名。
import { describe, expect, test } from "vitest";
import { BODY_PREVIEW_MAX, presentBody } from "./body.js";
import type { BrowserToolsDeps } from "./deps.js";

/** 只用到 fileMaxBytes / mask / saveAsset 的替身；mask 把 secret 改成 {{@secret}}。 */
function makeDeps(overrides: Partial<BrowserToolsDeps> = {}) {
  const saved: Array<{ name: string; bytes: Buffer }> = [];
  const masks: string[] = [];
  const deps = {
    fileMaxBytes: () => 1024 * 1024,
    mask(text: string) {
      masks.push(text);
      return text.replace(/secret/g, "{{@secret}}");
    },
    async saveAsset({ name, bytes }: { name: string; bytes: Buffer }) {
      saved.push({ name, bytes });
      return { marker: `[attach_file] path=${name}` };
    },
    ...overrides,
  } as unknown as BrowserToolsDeps;
  return { deps, saved, masks };
}

describe("presentBody", () => {
  test("文本不超预览：整段内联、不过附件也不调 mask 之外的路径", async () => {
    const { deps, saved, masks } = makeDeps();
    const out = await presentBody(deps, "s1", {
      bytes: Buffer.from("hello secret", "utf8"),
      mime: "application/json",
      name: "network-p1-41-response",
    });
    expect(out).toEqual({
      size: 12,
      text: "hello {{@secret}}",
      shownChars: 17,
      totalChars: 17,
      marker: null,
    });
    expect(masks).toEqual(["hello secret"]);
    expect(saved).toEqual([]);
  });

  test("文本超预览：前 4000 字符内联，整段（已遮罩）存附件", async () => {
    const { deps, saved } = makeDeps();
    const body = `secret${"文".repeat(BODY_PREVIEW_MAX + 100)}`;
    const out = await presentBody(deps, "s1", {
      bytes: Buffer.from(body, "utf8"),
      mime: "text/plain",
      name: "network-p1-41-request",
    });
    expect(out.text).toHaveLength(BODY_PREVIEW_MAX);
    expect(out.text?.startsWith("{{@secret}}")).toBe(true);
    expect(out.shownChars).toBe(BODY_PREVIEW_MAX);
    // 字节数是原文的字节数，字符数是遮罩后的长度。
    expect(out.size).toBe(Buffer.byteLength(body, "utf8"));
    // 遮罩后 secret 变成 {{@secret}}，多出 5 个字符。
    expect(out.totalChars).toBe(body.length + 5);
    expect(out.marker).toBe("[attach_file] path=network-p1-41-request.txt");
    expect(saved.map((s) => s.name)).toEqual(["network-p1-41-request.txt"]);
    const full = saved[0]?.bytes.toString("utf8") ?? "";
    expect(full.startsWith("{{@secret}}")).toBe(true);
    expect(full).toHaveLength(out.totalChars);
  });

  test("二进制：不内联、原字节存附件、不过 mask", async () => {
    const { deps, saved, masks } = makeDeps();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const out = await presentBody(deps, "s1", {
      bytes,
      mime: "image/png",
      name: "network-p1-42-response",
    });
    expect(out).toEqual({
      size: 7,
      text: null,
      shownChars: 0,
      totalChars: 0,
      marker: "[attach_file] path=network-p1-42-response.png",
    });
    expect(saved.map((s) => s.name)).toEqual(["network-p1-42-response.png"]);
    expect(saved[0]?.bytes.equals(bytes)).toBe(true);
    expect(masks).toEqual([]);
  });

  test("非法 UTF-8 当二进制", async () => {
    const { deps, saved } = makeDeps();
    const bytes = Buffer.from([0x68, 0x69, 0xc3, 0x28]);
    const out = await presentBody(deps, "s1", {
      bytes,
      mime: "text/plain",
      name: "network-p1-43-response",
    });
    expect(out.text).toBeNull();
    // mime 说文本，但字节解不出来：按二进制走，扩展名按 mime 查表（text/plain 不在表里就是 bin）。
    expect(saved.map((s) => s.name)).toEqual(["network-p1-43-response.bin"]);
  });

  test("超过 fileMaxBytes：抛中文错误，带两端的大小", async () => {
    const { deps, saved } = makeDeps({ fileMaxBytes: () => 10 });
    const err = await presentBody(deps, "s1", {
      bytes: Buffer.alloc(2048),
      mime: "text/plain",
      name: "n",
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("内容有 2.0 KB，超过大小上限（10 B）");
    expect(saved).toEqual([]);
  });

  test("扩展名按 mime 取；表里没有、mime 是空串时按文本 / 二进制回退", async () => {
    const { deps, saved } = makeDeps();
    const save = async (bytes: Buffer, mime: string) =>
      (await presentBody(deps, "s1", { bytes, mime, name: "n" })).marker;
    await save(Buffer.from("x".repeat(BODY_PREVIEW_MAX + 1)), "text/csv");
    await save(Buffer.from("x".repeat(BODY_PREVIEW_MAX + 1)), "");
    await save(Buffer.from([0xff, 0xfe]), "");
    await save(Buffer.from([0xff, 0xfe]), "application/x-unknown");
    await save(
      Buffer.from("x".repeat(BODY_PREVIEW_MAX + 1)),
      "application/json",
    );
    expect(saved.map((s) => s.name)).toEqual([
      "n.txt",
      "n.txt",
      "n.bin",
      "n.bin",
      "n.json",
    ]);
  });
});
