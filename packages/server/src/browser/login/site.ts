// 「站点」= 注册域（eTLD+1）：登录属于用户与站点之间，与工作区无关。
// 本机地址、IP、单标签主机名不属于任何站点（各端口共用 localhost，混在一起会串）。
import { createHash } from "node:crypto";
import { parse } from "tldts";
import type { StorageState } from "../engine/types.js";

/** 页面地址所属的站点（注册域，小写 ASCII）；是 IP / localhost / 单标签主机名、或没有主机名（file:、about:）返回 null。 */
export function siteOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return parse(host, { allowPrivateDomains: true }).domain;
}

/** cookie 的 domain（可能带前导点）或 origin 的 hostname 是否属于这个站点；后缀匹配必须带点边界。 */
function inSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^\./, "");
  return h === site || h.endsWith(`.${site}`);
}

/** 状态里属于这个站点（含子域）的 cookie 与 origin 条目。 */
export function pickSite(state: StorageState, site: string): StorageState {
  return {
    cookies: state.cookies.filter((c) => inSite(c.domain, site)),
    origins: state.origins.filter((o) => {
      try {
        return inSite(new URL(o.origin).hostname, site);
      } catch {
        return false;
      }
    }),
  };
}

/** 把若干份状态拼成一份（不去重）。 */
export function mergeStates(states: readonly StorageState[]): StorageState {
  return {
    cookies: states.flatMap((s) => s.cookies),
    origins: states.flatMap((s) => s.origins),
  };
}

/**
 * 状态的指纹：按键排序后哈希，顺序无关。
 * localStorage 只取 key 不取值（SPA 的状态值抖动太大）；IndexedDB 不参与。
 */
export function fingerprint(state: StorageState): string {
  const cookies = state.cookies
    .map((c) => [c.domain, c.path, c.name, c.value])
    .sort(compareKeys);
  const origins = state.origins
    .map((o) => [o.origin, ...o.localStorage.map((e) => e.name).sort()])
    .sort(compareKeys);
  return createHash("sha256")
    .update(JSON.stringify([cookies, origins]))
    .digest("hex");
}

const compareKeys = (a: readonly string[], b: readonly string[]): number => {
  const ka = JSON.stringify(a);
  const kb = JSON.stringify(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** 条数：cookies 与 origins 各多少。 */
export function countOf(state: StorageState): {
  cookies: number;
  origins: number;
} {
  return { cookies: state.cookies.length, origins: state.origins.length };
}
