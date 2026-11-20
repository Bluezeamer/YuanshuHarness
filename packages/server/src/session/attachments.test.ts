import { existsSync, readdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import {
  ATTACHMENT_MARKER,
  AttachmentDirectories,
  attachmentLine,
  attachmentNameOfPath,
  formatSize,
  imageMimeOf,
  injectAttachmentMarkers,
  isModelImageMime,
  mimeOfFile,
  resolveAttachmentPath,
  sanitizeAttachmentName,
  splitAttachmentMarkers,
} from "./attachments.js";

test("formatSize：B / KB / MB / GB，去掉多余的 .0", () => {
  expect(formatSize(0)).toBe("0 B");
  expect(formatSize(532)).toBe("532 B");
  expect(formatSize(1024)).toBe("1 KB");
  expect(formatSize(1536)).toBe("1.5 KB");
  expect(formatSize(3_460_300)).toBe("3.3 MB");
  expect(formatSize(1024 * 1024 * 1024)).toBe("1 GB");
});

test("imageMimeOf：按魔数识别 png/jpeg/gif/webp，其余不是图片", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(imageMimeOf(png)).toBe("image/png");
  expect(imageMimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(imageMimeOf(Buffer.from("GIF89a"))).toBe("image/gif");
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WEBP"),
  ]);
  expect(imageMimeOf(webp)).toBe("image/webp");
  expect(imageMimeOf(Buffer.from("hello"))).toBeNull();
  // 扩展名不参与图片判定：伪造 .png 的文本仍是按扩展名兜底的类型
  expect(mimeOfFile(Buffer.from("hello"), "a.png")).toBe(
    "application/octet-stream",
  );
});

test("isModelImageMime：只有静态图片模态 inline，GIF 按普通文件走路径", () => {
  expect(isModelImageMime("image/png")).toBe(true);
  expect(isModelImageMime("image/jpeg")).toBe(true);
  expect(isModelImageMime("image/webp")).toBe(true);
  // GIF 能识别成图片类型，但不作为图片输入交给模型
  expect(isModelImageMime("image/gif")).toBe(false);
  expect(isModelImageMime("text/plain")).toBe(false);
});

test("mimeOfFile：非图片按扩展名兜底，不认识给 octet-stream", () => {
  expect(mimeOfFile(Buffer.alloc(0), "note.txt")).toBe("text/plain");
  expect(mimeOfFile(Buffer.alloc(0), "page.html")).toBe("text/html");
  expect(mimeOfFile(Buffer.alloc(0), "a.pdf")).toBe("application/pdf");
  expect(mimeOfFile(Buffer.alloc(0), "data.json")).toBe("application/json");
  expect(mimeOfFile(Buffer.alloc(0), "blob.xyz")).toBe(
    "application/octet-stream",
  );
  // 魔数优先于扩展名
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(mimeOfFile(png, "blob.bin")).toBe("image/png");
});

test("sanitizeAttachmentName：中文等原样保留，只换分隔符、单引号与控制字符，保留扩展名并按字节限长", () => {
  expect(sanitizeAttachmentName("note.txt")).toBe("note.txt");
  expect(sanitizeAttachmentName("报告 v2 (终).pdf")).toBe("报告 v2 (终).pdf");
  expect(sanitizeAttachmentName("../evil.sh")).toBe(".._evil.sh");
  expect(sanitizeAttachmentName("a\\b/c'd\ne\u0000f.txt")).toBe(
    "a_b_c_d_e_f.txt",
  );
  // 基名限 160 字节：ASCII 160 个，中文 53 个（159 字节），不会把一个字切成半截；扩展名保留
  expect(sanitizeAttachmentName(`${"a".repeat(300)}.txt`)).toBe(
    `${"a".repeat(160)}.txt`,
  );
  expect(sanitizeAttachmentName(`${"文".repeat(100)}.txt`)).toBe(
    `${"文".repeat(53)}.txt`,
  );
  // 整个落盘名（前缀 + 名字 + 临时后缀）不超过 255 字节
  const worst = sanitizeAttachmentName(
    `${"文".repeat(100)}.${"档".repeat(30)}`,
  );
  expect(Buffer.byteLength(`ab12cd34-${worst}.ab12cd34.part`)).toBeLessThan(
    255,
  );
  expect(sanitizeAttachmentName("...").length).toBeGreaterThan(0);
});

test("标记行：注入格式严格符合契约，且能原样解析回来", () => {
  const text = "看这两个文件";
  const attachments = [
    {
      path: "./2026-10-27/ab12cd34-a.txt",
      mime: "text/plain",
      sizeText: "532 B",
    },
    {
      path: "./2026-10-27/ab12cd35-b.png",
      mime: "image/png",
      sizeText: "3.3 MB",
    },
  ];
  const injected = injectAttachmentMarkers(text, attachments);
  const lines = injected.split("\n");
  expect(lines[0]).toBe(text);
  expect(lines[1]).toBe("");
  expect(lines[2]).toBe(
    "[attach_file] attachment:/2026-10-27/ab12cd34-a.txt (text/plain, 532 B)",
  );
  expect(lines[3]).toBe(
    "[attach_file] attachment:/2026-10-27/ab12cd35-b.png (image/png, 3.3 MB)",
  );
  expect(lines[2]).toContain(ATTACHMENT_MARKER);

  const parsed = splitAttachmentMarkers(injected);
  expect(parsed.text).toBe(text);
  expect(parsed.attachments).toEqual([
    {
      name: "a.txt",
      mime: "text/plain",
      sizeText: "532 B",
      path: "./2026-10-27/ab12cd34-a.txt",
    },
    {
      name: "b.png",
      mime: "image/png",
      sizeText: "3.3 MB",
      path: "./2026-10-27/ab12cd35-b.png",
    },
  ]);
});

test("标记解析：没有标记时原样返回；只剥离末尾连续的标记行", () => {
  expect(splitAttachmentMarkers("普通消息")).toEqual({ text: "普通消息" });
  const withOne = injectAttachmentMarkers("hi", [
    { path: "./d/aaaaaaa1-a.txt", mime: "text/plain", sizeText: "1 B" },
  ]);
  // 前面不是契约格式的同类文本保留，末尾的标记照样剥
  expect(
    splitAttachmentMarkers(`[attach_file] 不是契约格式\n${withOne}`),
  ).toMatchObject({
    text: "[attach_file] 不是契约格式\nhi",
    attachments: [{ path: "./d/aaaaaaa1-a.txt" }],
  });
  // 用户原文为空时只有标记块
  const only = injectAttachmentMarkers("", [
    { path: "./d/aaaaaaa1-a.txt", mime: "text/plain", sizeText: "1 B" },
  ]);
  expect(splitAttachmentMarkers(only)).toMatchObject({
    text: "",
    attachments: [{ path: "./d/aaaaaaa1-a.txt" }],
  });
  // 尾部格式不合法的行不剥
  expect(
    splitAttachmentMarkers("x\n\n[attach_file] attachment:/a (text/plain)")
      .text,
  ).toBe("x\n\n[attach_file] attachment:/a (text/plain)");
});

test("resolveAttachmentPath：只接受会话 directory 内的相对路径", () => {
  const root = path.join(path.sep, "data", "attachments", "s1");
  expect(resolveAttachmentPath(root, "./2026-10-27/a.txt")).toBe(
    path.join(root, "2026-10-27", "a.txt"),
  );
  expect(resolveAttachmentPath(root, "2026-10-27/a.txt")).toBe(
    path.join(root, "2026-10-27", "a.txt"),
  );
  expect(resolveAttachmentPath(root, "./a/../b.txt")).toBeNull();
  expect(resolveAttachmentPath(root, "../other-session/a.txt")).toBeNull();
  expect(resolveAttachmentPath(root, "/etc/passwd")).toBeNull();
  expect(resolveAttachmentPath(root, "a\\..\\b")).toBeNull();
  expect(resolveAttachmentPath(root, "")).toBeNull();
  expect(resolveAttachmentPath(root, 5)).toBeNull();
  expect(resolveAttachmentPath(root, "a\0b")).toBeNull();
});

test("attachmentNameOfPath：去掉落盘随机前缀", () => {
  expect(attachmentNameOfPath("./2026-10-27/ab12cd34-note.txt")).toBe(
    "note.txt",
  );
  expect(attachmentNameOfPath("./2026-10-27/note.txt")).toBe("note.txt");
  expect(
    attachmentLine({ path: "./a", mime: "text/plain", sizeText: "1 B" }),
  ).toBe("[attach_file] attachment:/a (text/plain, 1 B)");
});

describe("AttachmentDirectories.reserve / save / saveFrom", () => {
  /** 真库 + 真 store，数据目录由 tmp-registry 统一删。 */
  const setup = (ownerOf?: (sessionId: string) => string) => {
    const dataDir = makeTmpDir("yuanshu-attach-save-");
    const db = openDatabase(dataDir);
    const dirs = new AttachmentDirectories(
      new DirectoryStore(db),
      dataDir,
      ownerOf,
    );
    /** 会话附件区里的所有文件名（递归、相对会话目录），用来找残留的 .part。 */
    const files = (sessionId: string): string[] => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else out.push(path.relative(dirs.pathOf(sessionId), p));
        }
      };
      if (existsSync(dirs.pathOf(sessionId))) walk(dirs.pathOf(sessionId));
      return out.sort();
    };
    return { dirs, files };
  };

  test("reserve：./<日期>/<8 位 hex>-<安全名>，日期目录已建好（0700）", async () => {
    const { dirs } = setup();
    const got = await dirs.reserve("s1", "照片 1.png");
    expect(got.relative).toMatch(
      /^\.\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-照片 1\.png$/,
    );
    expect(got.safe).toBe("照片 1.png");
    expect(got.abs).toBe(path.join(dirs.pathOf("s1"), got.relative.slice(2)));
    const st = await stat(path.dirname(got.abs));
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  test("reserve 两次得到两个不同路径", async () => {
    const { dirs } = setup();
    const a = await dirs.reserve("s1", "a.png");
    const b = await dirs.reserve("s1", "a.png");
    expect(a.relative).not.toBe(b.relative);
    expect(a.safe).toBe(b.safe);
  });

  test("save：字节原样、mime 按魔数、path 形状正确", async () => {
    const { dirs } = setup();
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("body"),
    ]);
    const saved = await dirs.save("s1", "shot.png", png);
    expect(saved.path).toMatch(
      /^\.\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-shot\.png$/,
    );
    expect(saved.mime).toBe("image/png");
    expect(saved.size).toBe(png.length);
    expect(saved.sizeText).toBe(`${png.length} B`);
    const back = await readFile(
      path.join(dirs.pathOf("s1"), saved.path.slice(2)),
    );
    expect(back.equals(png)).toBe(true);
  });

  test("save：中文文件名原样落盘；没有残留的 .part", async () => {
    const { dirs, files } = setup();
    const saved = await dirs.save("s1", "图片名称.jpg", Buffer.from("jpg"));
    expect(saved.path).toMatch(
      /^\.\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-图片名称\.jpg$/,
    );
    const list = files("s1");
    expect(list).toHaveLength(1);
    expect(list[0]?.endsWith(".part")).toBe(false);
    expect(list[0]?.endsWith(saved.path.slice(2).split("/")[1] as string)).toBe(
      true,
    );
  });

  test("save：先写同目录临时名再 rename（不留残文件）", async () => {
    const { dirs } = setup();
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const env = dirs.env;
    const realWrite = env.writeFile.bind(env);
    const realRename = env.rename.bind(env);
    env.writeFile = (p, data) => {
      writes.push(p);
      return realWrite(p, data);
    };
    env.rename = (from, to) => {
      renames.push([from, to]);
      return realRename(from, to);
    };
    const saved = await dirs.save("s1", "a.png", Buffer.from("x"));
    const abs = path.join(dirs.pathOf("s1"), saved.path.slice(2));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\.part$/);
    expect(renames).toEqual([[writes[0] as string, abs]]);
  });

  test("save：同名两次得到两个不同路径，展示名一致", async () => {
    const { dirs } = setup();
    const a = await dirs.save("s1", "same.png", Buffer.from("a"));
    const b = await dirs.save("s1", "same.png", Buffer.from("b"));
    expect(a.path).not.toBe(b.path);
    expect(attachmentNameOfPath(a.path)).toBe("same.png");
    expect(attachmentNameOfPath(b.path)).toBe("same.png");
  });

  test("removeSession（没有工作区、回退成会话自己）：目录与 directory 行都清掉，别的会话不受影响", async () => {
    const { dirs } = setup();
    await dirs.save("s1", "a.png", Buffer.from("a"));
    await dirs.save("s2", "b.png", Buffer.from("b"));
    expect(dirs.get("s1")).toBeDefined();

    await dirs.removeSession("s1");
    expect(existsSync(dirs.pathOf("s1"))).toBe(false);
    expect(dirs.get("s1")).toBeUndefined();
    expect(existsSync(dirs.pathOf("s2"))).toBe(true);
    expect(dirs.get("s2")).toBeDefined();

    await expect(dirs.removeSession("never")).resolves.toBeUndefined();
  });

  test("按工作区存放：同一工作区的会话共用一块附件区，删会话不清；删属主才清", async () => {
    const { dirs } = setup((id) => (id === "loose" ? id : "ws-1"));
    const saved = await dirs.save("parent", "a.png", Buffer.from("a"));
    // 子会话（同一工作区）看到同一块：路径、归属行都一样
    expect(dirs.pathOf("child")).toBe(dirs.pathOf("parent"));
    expect(dirs.get("child")?.id).toBe(dirs.get("parent")?.id);
    expect(
      existsSync(path.join(dirs.pathOf("child"), saved.path.slice(2))),
    ).toBe(true);

    // 删会话不动工作区的附件区
    await dirs.removeSession("parent");
    expect(dirs.get("child")).toBeDefined();
    expect(existsSync(dirs.pathOf("child"))).toBe(true);

    // 没有工作区的会话照旧回退成自己
    await dirs.save("loose", "b.png", Buffer.from("b"));
    await dirs.removeSession("loose");
    expect(dirs.get("loose")).toBeUndefined();

    // 删工作区才清
    await dirs.removeOwner("ws-1");
    expect(dirs.get("child")).toBeUndefined();
    expect(existsSync(path.join(dirs.root, "ws-1"))).toBe(false);
  });

  test("saveFrom：流式写进去，路径 / mime（按文件头嗅探）/ 大小都对", async () => {
    const { dirs, files } = setup();
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("body"),
    ]);
    const saved = await dirs.saveFrom("s1", "图表.png", async (abs) => {
      await writeFile(abs, png);
    });
    expect(saved.path).toMatch(
      /^\.\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-图表\.png$/,
    );
    expect(saved.name).toBe("图表.png");
    expect(saved.mime).toBe("image/png");
    expect(saved.size).toBe(png.length);
    expect(saved.sizeText).toBe(`${png.length} B`);
    const back = await readFile(
      path.join(dirs.pathOf("s1"), saved.path.slice(2)),
    );
    expect(back.equals(png)).toBe(true);
    expect(files("s1").some((f) => f.endsWith(".part"))).toBe(false);
  });

  test("saveFrom：write 抛错时不留残文件，错误原样抛出", async () => {
    const { dirs, files } = setup();
    const boom = new Error("写磁盘失败");
    const err = await dirs
      .saveFrom("s1", "a.bin", async (abs) => {
        await writeFile(abs, "half");
        throw boom;
      })
      .catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(files("s1")).toEqual([]);
  });
});
