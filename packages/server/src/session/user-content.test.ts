// 用户内容解析入口：附件路径 → 校验 → mime → 读图压缩 → 追加标记行。
// 这里只测纯逻辑，会话与池的接线由 pool.test.ts / attachments.test.ts 覆盖。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { VirtualEnv } from "../env/virtual.js";
import { PI_IMAGE_COMPRESSION } from "../store/defaults.js";
import type { ImageResize } from "./image-compression.js";
import { resolveUserContent } from "./user-content.js";

// 合法的 1x1 PNG（只看魔数与 base64 往返，不需要真的解码）。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface World {
  dir: string;
  env: VirtualEnv;
  ctx: Parameters<typeof resolveUserContent>[0];
  resizes: { mime: string; options: unknown }[];
}

// 一个只读的附件区：`<tmp>/attach`。
function world(
  o: { images?: boolean; resize?: ImageResize | null } = {},
): World {
  const dir = makeTmpDir("yuanshu-user-content-");
  const root = path.join(dir, "attach");
  mkdirSync(path.join(root, "2026-11-20"), { recursive: true });
  writeFileSync(path.join(root, "2026-11-20", "aaaaaaa1-note.txt"), "abc");
  writeFileSync(path.join(root, "2026-11-20", "aaaaaaa2-p.png"), PNG);
  writeFileSync(path.join(dir, "outside.txt"), "nope");
  const env = new VirtualEnv(root);
  const resizes: { mime: string; options: unknown }[] = [];
  const ctx = {
    attachmentDir: () => ({ env, path: root }),
    supportsImages: () => o.images !== false,
    compression: () => PI_IMAGE_COMPRESSION,
    resize:
      o.resize === null
        ? undefined
        : (o.resize ??
          (async (bytes: Uint8Array, mime: string, options: unknown) => {
            resizes.push({ mime, options });
            return {
              data: Buffer.from(bytes).toString("base64"),
              mimeType: mime,
              originalWidth: 1,
              originalHeight: 1,
              width: 1,
              height: 1,
              wasResized: false,
            };
          })),
  } satisfies Parameters<typeof resolveUserContent>[0];
  return { dir, env, ctx, resizes };
}

describe("resolveUserContent", () => {
  test("没有附件：原文原样返回，不碰附件区", async () => {
    const ctx = {
      attachmentDir: () => {
        throw new Error("不该碰附件区");
      },
      supportsImages: () => false,
      compression: () => PI_IMAGE_COMPRESSION,
    };
    expect(await resolveUserContent(ctx, "你好", [])).toEqual({
      text: "你好",
      images: [],
      attachments: [],
    });
  });

  test("带图片（模型支持）：图片压缩后交给模型，文字尾部追加标记行", async () => {
    const w = world();
    const c = await resolveUserContent(w.ctx, "看图", [
      "./2026-11-20/aaaaaaa2-p.png",
    ]);
    expect(c.text).toBe(
      "看图\n\n[attach_file] attachment:/2026-11-20/aaaaaaa2-p.png (image/png, 70 B)",
    );
    expect(c.images).toHaveLength(1);
    expect(c.images[0]?.mimeType).toBe("image/png");
    expect(w.resizes).toHaveLength(1);
    expect(c.attachments).toEqual([
      {
        name: "p.png",
        mime: "image/png",
        sizeText: "70 B",
        path: "./2026-11-20/aaaaaaa2-p.png",
      },
    ]);
  });

  test("模型不支持图片：拒绝", async () => {
    const w = world({ images: false });
    await expect(
      resolveUserContent(w.ctx, "看图", ["./2026-11-20/aaaaaaa2-p.png"]),
    ).rejects.toThrow("当前模型不支持图片输入");
  });

  test("越界与不存在都拒绝", async () => {
    const w = world();
    // 与 send_message 原有语义一致：越界与解析不到真实路径都报路径无效。
    for (const p of [
      "../outside.txt",
      "/etc/passwd",
      "./2026-11-20/missing.png",
    ])
      await expect(resolveUserContent(w.ctx, "x", [p])).rejects.toThrow(
        "附件路径无效",
      );
    // 目录不是文件：报不存在
    await expect(
      resolveUserContent(w.ctx, "x", ["./2026-11-20"]),
    ).rejects.toThrow("附件不存在，请重新上传");
  });

  test("没有附件区：拒绝", async () => {
    const w = world();
    await expect(
      resolveUserContent({ ...w.ctx, attachmentDir: () => null }, "x", [
        "./2026-11-20/aaaaaaa1-note.txt",
      ]),
    ).rejects.toThrow("附件不存在，请重新上传");
  });

  test("非图片只出标记行，不读字节也不压缩", async () => {
    const w = world();
    const c = await resolveUserContent(w.ctx, "看文件", [
      "./2026-11-20/aaaaaaa1-note.txt",
    ]);
    expect(c.images).toEqual([]);
    expect(w.resizes).toEqual([]);
    expect(c.text).toContain("(text/plain, 3 B)");
    expect(c.attachments).toEqual([
      {
        name: "note.txt",
        mime: "text/plain",
        sizeText: "3 B",
        path: "./2026-11-20/aaaaaaa1-note.txt",
      },
    ]);
  });

  test("只给附件不给文字：文字就是标记行", async () => {
    const w = world();
    const c = await resolveUserContent(w.ctx, "", [
      "./2026-11-20/aaaaaaa1-note.txt",
    ]);
    expect(c.text.startsWith("[attach_file] ")).toBe(true);
  });
});
