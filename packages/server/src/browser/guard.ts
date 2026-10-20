// 浏览器只访问 http(s)：file:、chrome:、data:、view-source: 会绕过路径规则或读到浏览器内部页面。
export function parseHttpUrl(raw: string): URL | null {
  const s = raw.trim();
  if (s === "" || s.length > 4096) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// 审批与放行的粒度：协议 + 主机 + 端口。
export const originOf = (url: string): string | null =>
  parseHttpUrl(url)?.origin ?? null;
