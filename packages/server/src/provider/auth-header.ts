// 自定义鉴权头：写成「头名」或「头名: 前缀」，如 X-Api-Key、Authorization: Token；密钥拼在前缀之后。
// 留空则按协议默认（Bearer / x-api-key）。

export interface AuthHeader {
  name: string;
  scheme: string;
}

export const AUTH_HEADER_MAX = 128;

// 头名取 RFC 7230 的 token 字符；前缀只许可打印 ASCII，避免换行等把请求头截断。
const NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const SCHEME = /^[\x20-\x7e]*$/;

export function parseAuthHeader(raw: string): AuthHeader | null {
  const i = raw.indexOf(":");
  const name = (i < 0 ? raw : raw.slice(0, i)).trim();
  const scheme = i < 0 ? "" : raw.slice(i + 1).trim();
  return NAME.test(name) && SCHEME.test(scheme) ? { name, scheme } : null;
}

/** 存库的规范写法：去掉多余空白。 */
export const formatAuthHeader = (h: AuthHeader): string =>
  h.scheme ? `${h.name}: ${h.scheme}` : h.name;

export const authHeaderValue = (h: AuthHeader, key: string): string =>
  h.scheme ? `${h.scheme} ${key}` : key;
