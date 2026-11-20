// 浏览器本地状态（localStorage）的统一读写：输入框草稿、画布暂存、树栏偏好这类「设备相关、丢了无害」的状态都走这里。
// 值一律是 JSON；读时经调用方给的校验函数，坏了或没有当作没有；写失败（配额、隐私模式）吞掉；超过容量上限就不存。
// 字号、令牌、当前工作区有各自的存放语义（sessionStorage、启动前同步读），不走这里。

const ROOT = "ys.";

/** 单条默认上限（字符数）。大文本草稿超过它就不暂存 */
export const DEFAULT_MAX_CHARS = 1_000_000;

interface Pending {
  value: unknown;
  maxChars: number;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();
let hooked = false;

/** 键 = `ys.<命名空间>[:<分段>…]`。分段做 URI 编码，冒号不会出现在段内，所以按前缀清理不会串 */
export const localKey = (ns: string, ...parts: string[]): string =>
  [`${ROOT}${ns}`, ...parts.map(encodeURIComponent)].join(":");

/** 某命名空间（可再带前几段）之下所有键的前缀 */
export const localPrefix = (ns: string, ...parts: string[]): string =>
  `${localKey(ns, ...parts)}:`;

export function decodeLocal<T>(
  raw: string | null,
  parse: (v: unknown) => T | null,
): T | null {
  if (raw === null) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readLocal<T>(
  key: string,
  parse: (v: unknown) => T | null,
): T | null {
  flushLocal(key);
  try {
    return decodeLocal(localStorage.getItem(key), parse);
  } catch {
    return null;
  }
}

export function removeLocal(key: string): void {
  pending.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上：存储不可用就当没有
  }
}

/** 立即写。太大或写不进去时删掉旧值：留着旧的只会在下次恢复出过期的内容 */
export function writeLocal(
  key: string,
  value: unknown,
  maxChars = DEFAULT_MAX_CHARS,
): void {
  pending.delete(key);
  try {
    const raw = JSON.stringify(value);
    if (raw.length > maxChars) throw new Error("too large");
    localStorage.setItem(key, raw);
  } catch {
    removeLocal(key);
  }
}

/** 防抖写：同一个键连续写只落最后一次（序列化也只做这一次）；读同一个键、页面隐藏或关闭时先落下 */
export function writeLocalSoon(
  key: string,
  value: unknown,
  ms = 400,
  maxChars = DEFAULT_MAX_CHARS,
): void {
  const old = pending.get(key);
  if (old) clearTimeout(old.timer);
  pending.set(key, {
    value,
    maxChars,
    timer: setTimeout(() => flushLocal(key), ms),
  });
  if (!hooked && typeof window !== "undefined") {
    hooked = true;
    window.addEventListener("pagehide", () => flushLocal());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushLocal();
    });
  }
}

/** 把还在等的防抖写立刻落下：给了键只落那一个，不给就全部 */
export function flushLocal(key?: string): void {
  const keys = key === undefined ? [...pending.keys()] : [key];
  for (const k of keys) {
    const p = pending.get(k);
    if (!p) continue;
    clearTimeout(p.timer);
    writeLocal(k, p.value, p.maxChars);
  }
}

/** 按前缀清理：drop 收到解析后的值，返回 true 就删；解析不了的（坏记录）一律删。先落下防抖里的写，免得删完又被写回来 */
export function sweepLocal(
  prefix: string,
  drop: (key: string, value: unknown) => boolean,
): void {
  flushLocal();
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      let value: unknown;
      try {
        value = JSON.parse(localStorage.getItem(key) ?? "");
      } catch {
        removeLocal(key);
        continue;
      }
      if (drop(key, value)) removeLocal(key);
    }
  } catch {
    // 存储不可用：没有可清的
  }
}
