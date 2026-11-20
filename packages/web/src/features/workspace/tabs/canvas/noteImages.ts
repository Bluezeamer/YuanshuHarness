// 往 `.canvas/` 里的笔记粘贴 / 拖入图片：和普通 md 同一规则（`<笔记名>.assets/`、相对路径的标准链接），
// 但走画布接口——那是唯一会让笔记改名 / 挪动 / 删除时带着资源夹一起走的入口。
import { uploadNoteAsset } from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import { sizeText } from "../files/paths";
import {
  type ImageSource,
  imageFileName,
  isImageFile,
  linkSeg,
} from "../preview/mdImages";

const FAIL: Record<string, string> = {
  network: "连不上服务端",
  forbidden: "没有权限",
  not_found: "笔记已经不存在",
  too_large: "图片太大",
};

/** 服务端返回的相对 `.canvas/` 的资源路径 → 相对这篇笔记的链接地址（`./访谈.assets/a%20b.png`） */
export function relativeLink(note: string, asset: string): string {
  const prefix = note.includes("/")
    ? note.slice(0, note.lastIndexOf("/") + 1)
    : "";
  const rel = asset.startsWith(prefix) ? asset.slice(prefix.length) : asset;
  return `./${rel.split("/").map(linkSeg).join("/")}`;
}

/** 把图片存进笔记的资源夹，返回要插入的 markdown（多张用空行隔开）；没有可存的图片返回 null，失败返回原因 */
export async function saveNoteImages(
  env: string,
  project: string,
  note: string,
  files: readonly File[],
  source: ImageSource,
): Promise<{ ok: true; text: string | null } | { ok: false; why: string }> {
  const images = files.filter(isImageFile);
  if (images.length === 0) return { ok: true, text: null };
  const links: string[] = [];
  for (const f of images) {
    const r = await uploadNoteAsset(
      loadToken(),
      env,
      project,
      note,
      f,
      imageFileName(f, source),
    );
    if (!r.ok)
      return {
        ok: false,
        why:
          r.kind === "too_large" && r.max !== undefined
            ? `图片太大（上限 ${sizeText(r.max)}）`
            : (FAIL[r.kind] ?? "保存失败"),
      };
    links.push(`![](${relativeLink(note, r.data.path)})`);
  }
  return { ok: true, text: links.join("\n\n") };
}
