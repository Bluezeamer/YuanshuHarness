/** 绝对时间：本地时区 `YYYY-MM-DD HH:mm`；缺时间或解析失败返回空串（调用方据此不显示或换占位）。 */
export function fmtDateTime(
  at: Date | string | number | null | undefined,
): string {
  if (at === undefined || at === null || at === "") return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
