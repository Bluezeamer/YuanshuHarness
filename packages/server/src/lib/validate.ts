// 入参校验的小件：api 与服务层共用，放包根避免服务层反向依赖 api。

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 非空字符串，去首尾空白后长度不超过 max；否则 null。 */
export const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max
    ? v.trim()
    : null;

/** 查询串里的正整数（不含 0），超过 max 或格式不对为 null。 */
export const posInt = (v: string | undefined, max = Number.MAX_SAFE_INTEGER) =>
  v !== undefined && /^[1-9][0-9]*$/.test(v) && Number(v) <= max
    ? Number(v)
    : null;
