// 浏览器设置页的纯函数：服务端的元信息 → 展示文字。
import type { LoginMeta } from "../../../api/browser";

/** 行上的一句说明：存了什么（只有条数，没有内容）与保存时间。 */
export function describeLogin(m: LoginMeta): string {
  const parts = [`${m.cookies} 个 cookie`, `${m.origins} 个站点存储`];
  const at = new Date(m.savedAt);
  if (!Number.isNaN(at.getTime()))
    parts.push(
      `保存于 ${at.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}`,
    );
  return parts.join(" · ");
}

/** 下载镜像的校验：空 = 不用；否则要是 http(s) 地址（与服务端同一条规则）。返回错误文案或 null。 */
export function mirrorError(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (v.length > 512) return "地址太长，最多 512 个字符";
  try {
    const { protocol } = new URL(v);
    if (protocol === "http:" || protocol === "https:") return null;
  } catch {}
  return "要填以 http 或 https 开头的完整地址";
}
