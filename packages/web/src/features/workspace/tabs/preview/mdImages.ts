// 往普通 md 文件里粘贴 / 拖入图片（含 svg）：图片统一存到 md 所在目录的隐藏文件夹 `.assets/<md 文件名>/`
// （按文件名分一层，md 一多也不会把目录淹没），光标处插入相对路径的标准链接 `![](./.assets/<名>/<文件>)`。
// `.canvas/` 里的笔记走画布接口（canvas/noteImages.ts），规则相同。
import { listFiles, makeDir, uploadFile } from "../../../../api/files";
import { loadToken } from "../../../../api/http";
import { baseName, freeName, joinPath, parentOf } from "../files/paths";
import { uploadFailText } from "../files/upload";

export type ImageSource = "paste" | "drop";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const EXT_OF_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

export const isMarkdownPath = (path: string): boolean =>
  /\.(md|markdown)$/i.test(path);

export const isImageFile = (f: File): boolean =>
  f.type.startsWith("image/") || IMAGE_EXT.test(f.name);

/** md 所在目录里放它图片的文件夹：`/w/笔记.md` → `/w/.assets/笔记`，`/w/a.b.md` → `/w/.assets/a.b` */
export const assetsDirOf = (path: string): string =>
  joinPath(
    joinPath(parentOf(path), ".assets"),
    baseName(path).replace(/\.[^.]*$/, ""),
  );

const two = (n: number) => String(n).padStart(2, "0");

/**
 * 存进资源夹的文件名：浏览器给截图的名字都是泛泛的 `image.png`，改成 `image-日期时间.png`；
 * 拖入的、或粘贴来的有真名字的文件保留原名。
 */
export function imageFileName(
  f: { name: string; type: string },
  source: ImageSource,
  now = new Date(),
): string {
  const generic = source === "paste" && /^image\.\w+$/i.test(f.name);
  if (!generic && f.name !== "") return f.name;
  const ext = EXT_OF_MIME[f.type] ?? (/\.(\w+)$/.exec(f.name)?.[1] || "png");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `image-${stamp}.${ext}`;
}

/** 放进 markdown 链接地址里：空格、括号、百分号等会破坏链接或被误读的字符转义，中文保持原样 */
export const linkSeg = (s: string): string =>
  s.replace(/[%\s()<>#?]/g, (c) =>
    // encodeURIComponent 不转义括号
    c.charCodeAt(0) < 128
      ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
      : encodeURIComponent(c),
  );

/** `![](./.assets/<md 名>/<文件>)`：stem 是 md 的文件名（不带扩展名） */
export const imageLink = (stem: string, fileName: string): string =>
  `![](./.assets/${linkSeg(stem)}/${linkSeg(fileName)})`;

/**
 * 把图片存进 md 所在目录的 `.assets/<md 名>/`（没有就建），返回要插入的 markdown（多张用空行隔开）；
 * 没有可存的图片返回 null，失败返回原因（已存下的那几张不回滚）。
 */
export async function saveMdImages(
  env: string,
  mdPath: string,
  files: readonly File[],
  source: ImageSource,
  sessionId: string | null,
): Promise<{ ok: true; text: string | null } | { ok: false; why: string }> {
  const images = files.filter(isImageFile);
  if (images.length === 0) return { ok: true, text: null };
  const token = loadToken();
  const dir = assetsDirOf(mdPath);
  const listed = await listFiles(token, env, dir, true);
  let taken: Set<string>;
  if (listed.ok) taken = new Set(listed.data.entries.map((e) => e.name));
  else if (listed.kind === "not_found") {
    const made = await makeDir(token, env, dir, sessionId);
    if (!made.ok) return { ok: false, why: uploadFailText(made.kind) };
    taken = new Set();
  } else return { ok: false, why: uploadFailText(listed.kind) };

  const links: string[] = [];
  for (const f of images) {
    const name = freeName(taken, imageFileName(f, source));
    const r = await uploadFile(
      token,
      env,
      joinPath(dir, name),
      f,
      false,
      sessionId,
    );
    if (!r.ok) return { ok: false, why: uploadFailText(r.kind) };
    taken.add(name);
    links.push(imageLink(baseName(dir), name));
  }
  return { ok: true, text: links.join("\n\n") };
}
