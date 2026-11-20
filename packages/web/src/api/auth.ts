// 会话 Cookie 的开启/关闭：HTML 预览的 iframe 内部请求带不了 Authorization 头，
// 必须让浏览器用 Cookie 自动带上凭据，所以登录后顺手把令牌落到 HttpOnly Cookie。
import { call } from "./http";

export const openSession = (token: string | null) =>
  call("POST", "/api/v1/auth/session", token, undefined, () => undefined);

export const closeSession = (token: string | null) =>
  call("DELETE", "/api/v1/auth/session", token, undefined, () => undefined);
