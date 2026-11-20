// 转发出口的闸门：只认会话 Cookie（浏览器带过来的）。
// 不看 Authorization 与 WebSocket 子协议：那是应用自己的凭据（JWT 之类），拿来当 Server 令牌判会把应用的接口全拦掉。
import type http from "node:http";
import { extractToken, tokenMatches } from "../auth.js";

/** 没配令牌（只允许回环监听）时恒为 true。 */
export function createForwardAuthorizer(
  token: string | undefined,
): (headers: http.IncomingHttpHeaders) => boolean {
  return (headers) => {
    if (token === undefined) return true;
    const given = extractToken({ cookie: headers.cookie });
    return given !== undefined && tokenMatches(token, given);
  };
}
