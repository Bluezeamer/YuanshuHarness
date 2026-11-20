// 「添加设备」的纯逻辑：配对链接怎么拼、地址对不对、配对码还剩多久。

/** 手机访问的地址：去空白与末尾的斜杠；没写协议就沿用当前页面的（局域网 IP 多是 http，域名多是 https） */
export function normalizeBase(raw: string): string {
  const [, scheme = `${location.protocol}//`, rest = ""] =
    /^(https?:\/\/)?(.*?)\/*$/i.exec(raw.trim()) ?? [];
  return rest === "" ? "" : `${scheme}${rest}`;
}

/** 扫码打开的配对链接 */
export const pairingUrl = (base: string, code: string): string =>
  `${normalizeBase(base)}/m/?pair=${encodeURIComponent(code)}`;

/** 这个地址手机打不开：指向本机（localhost、回环地址），或根本不是地址 */
export function addressProblem(base: string): "local" | "invalid" | null {
  const b = normalizeBase(base);
  if (b === "") return "invalid";
  let host: string;
  try {
    host = new URL(b).hostname;
  } catch {
    return "invalid";
  }
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  )
    return "local";
  return null;
}

/** 配对码还剩多少毫秒（过期后是 0） */
export const remainingMs = (expiresAt: string, now: number): number =>
  Math.max(0, new Date(expiresAt).getTime() - now);

/** 「4 分 05 秒」 */
export function fmtRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}
