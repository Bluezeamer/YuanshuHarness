// 服务转发的头改写：交给上游的是「它自己」的视角（localhost:<port>），回给浏览器的是转发出口的视角。
import type http from "node:http";
import { SESSION_COOKIE } from "../auth.js";
import { outboundHeaders } from "../lib/tunnel-http.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const asList = (value: string | string[] | number | undefined): string[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
};

/** 摘掉会话 Cookie，其余项原样保留；摘完没有剩下就返回 null（调用方据此删头）。 */
function stripSessionCookie(raw: string): string | null {
  const kept = raw
    .split(";")
    .filter((part) => {
      const at = part.indexOf("=");
      return (at < 0 ? "" : part.slice(0, at).trim()) !== SESSION_COOKIE;
    })
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return kept.length === 0 ? null : kept.join("; ");
}

/** Referer 只换 origin 部分，路径与查询保留；解析不了就丢掉这个头。 */
function rewriteReferer(value: string, self: string): string | null {
  try {
    const url = new URL(value);
    return `${self}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** 交给上游的请求头：去逐跳头、摘掉会话 Cookie、把 Host / Origin / Referer 改成上游自己的 localhost:<port>。 */
export function upstreamHeaders(
  raw: http.IncomingHttpHeaders,
  port: number,
  options?: { upgrade?: boolean },
): http.OutgoingHttpHeaders {
  const self = `http://localhost:${port}`;
  const out = outboundHeaders(raw, `localhost:${port}`, options);
  for (const name of Object.keys(out)) {
    const lower = name.toLowerCase();
    if (lower === "cookie") {
      const stripped = stripSessionCookie(asList(out[name]).join("; "));
      if (stripped === null) delete out[name];
      else out[name] = stripped;
    } else if (lower === "origin") {
      out[name] = self;
    } else if (lower === "referer") {
      const value = asList(out[name])[0] ?? "";
      const rewritten = rewriteReferer(value, self);
      if (rewritten === null) delete out[name];
      else out[name] = rewritten;
    }
  }
  return out;
}

/** 上游自己（回环、且端口就是上游端口）的绝对地址才改回转发出口，其余原样。 */
function rewriteLocation(
  value: string,
  port: number,
  forwardHost: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value; // 相对路径
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // 地址里没写端口就是协议默认端口（URL 解析后 port 为空串）
  const urlPort =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!LOOPBACK.has(host) || urlPort !== port) return value;
  return `http://${forwardHost}${url.pathname}${url.search}${url.hash}`;
}

/** 是不是在设 Server 的会话 Cookie：Cookie 不分端口，应用设同名的会把用户的登录顶掉。 */
const setsSessionCookie = (setCookie: string): boolean =>
  setCookie.slice(0, setCookie.indexOf("=")).trim() === SESSION_COOKIE;

/**
 * 响应头：指回上游回环的 Location 改成转发出口（`http://<请求的 Host>`）；
 * Set-Cookie 去掉 Domain 属性，并丢掉设 Server 会话 Cookie 的那几条。
 */
export function downstreamHeaders(
  raw: http.IncomingHttpHeaders,
  port: number,
  forwardHost: string,
): http.OutgoingHttpHeaders {
  const out = outboundHeaders(raw);
  for (const name of Object.keys(out)) {
    const lower = name.toLowerCase();
    const value = out[name];
    if (lower === "location") {
      const rewrite = (v: string) => rewriteLocation(v, port, forwardHost);
      out[name] = Array.isArray(value)
        ? value.map(rewrite)
        : rewrite(String(value));
    } else if (lower === "set-cookie") {
      const strip = (v: string) => v.replace(/;\s*domain=[^;]*/gi, "");
      const kept = (Array.isArray(value) ? value : [String(value)])
        .filter((v) => !setsSessionCookie(v))
        .map(strip);
      if (kept.length === 0) delete out[name];
      else out[name] = kept;
    }
  }
  return out;
}
