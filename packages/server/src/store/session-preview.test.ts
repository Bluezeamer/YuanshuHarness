import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  firstPreview,
  PREVIEW_MAX,
  previewOf,
  readPreview,
} from "./session-preview.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const user = (text: string) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (text: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const ATTACH = "\n\n[attach_file] attachment:/a/1.png (image/png, 12 B)";

describe("previewOf", () => {
  test("去掉附件尾行、折叠空白", () => {
    expect(previewOf(`修复  登录\n\n 失效${ATTACH}`)).toBe("修复 登录 失效");
  });

  test("按码点截到 48 字，emoji 不被切坏", () => {
    const long = "字".repeat(60);
    expect(previewOf(long)).toBe("字".repeat(PREVIEW_MAX));
    const emoji = "😀".repeat(60);
    const cut = previewOf(emoji);
    expect([...(cut ?? "")]).toHaveLength(PREVIEW_MAX);
    expect(cut).toBe("😀".repeat(PREVIEW_MAX));
  });

  test("空、纯空白、只有附件行都是 null", () => {
    for (const t of ["", "  \n\t ", ATTACH.trim()])
      expect(previewOf(t)).toBeNull();
  });
});

describe("firstPreview", () => {
  test("跳过非用户消息与清完为空的用户消息，取到下一条", () => {
    const entries = [
      { type: "session_info" },
      assistant("先说话"),
      // 只有图片、没有文本的用户消息
      { type: "message", message: { role: "user", content: [] } },
      user(`第一版方案${ATTACH}`),
      user("第二版方案"),
    ];
    expect(firstPreview(entries)).toBe("第一版方案");
    expect(firstPreview([assistant("只有助手")])).toBeNull();
  });
});

describe("readPreview", () => {
  test("坏行跳过、找到即停", () => {
    dir = mkdtempSync(join(tmpdir(), "yuanshu-preview-"));
    const file = join(dir, "s.jsonl");
    const lines = [
      { type: "session", version: 3, id: "x", timestamp: "t", cwd: dir },
      '{ "broken"',
      assistant("助手"),
      user(`第一条${ATTACH}`),
      user("第二条不该被读到"),
    ];
    writeFileSync(
      file,
      `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
    );
    expect(readPreview(file)).toBe("第一条");
  });
});
