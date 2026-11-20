// 文件管理器用的纯函数：路径拼接/父级/包含关系、重名改名、体积与时间的展示。
// 路径按 POSIX 处理（服务端要求绝对路径；Windows 主机尚未适配）。

export const baseName = (p: string): string =>
  p.split("/").filter(Boolean).pop() ?? "/";

export const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

export function parentOf(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** p 是否严格位于 dir 之下（不含 dir 自身） */
export const isUnder = (p: string, dir: string): boolean =>
  p !== dir && p.startsWith(dir === "/" ? "/" : `${dir}/`);

export interface Crumb {
  name: string;
  path: string;
}

/** 面包屑：根 + 逐级目录，每段带到该段为止的绝对路径 */
export function crumbsOf(path: string): Crumb[] {
  const parts = path.split("/").filter(Boolean);
  return [
    { name: "/", path: "/" },
    ...parts.map((name, i) => ({
      name,
      path: `/${parts.slice(0, i + 1).join("/")}`,
    })),
  ];
}

/**
 * 重名不覆盖：name 已被占用时在扩展名前加 ` (2)`、` (3)`…；目录没有扩展名。
 * 点开头的名字（.gitignore）不当作扩展名。
 */
export function freeName(
  taken: ReadonlySet<string>,
  name: string,
  isDir = false,
): string {
  if (!taken.has(name)) return name;
  const dot = isDir ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** 今年内 `MM-DD HH:mm`，更早 `YYYY-MM-DD` */
export function timeText(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const date = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === now.getFullYear()
    ? `${date} ${two(d.getHours())}:${two(d.getMinutes())}`
    : `${d.getFullYear()}-${date}`;
}
