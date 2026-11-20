import { MAPPING } from "./file-icons.generated";

const lower = (s: string) => s.toLowerCase();

/** 文件名 → 图标名：特殊文件名 → 前缀 → 复合后缀 → 扩展名 → 默认，大小写不敏感 */
export function fileIconName(name: string): string {
  const n = lower(name);
  const exact = (MAPPING.files as Record<string, string>)[n];
  if (exact) return exact;
  for (const [prefix, icon] of MAPPING.prefixes)
    if (n.startsWith(prefix)) return icon;
  // 复合后缀（.d.ts、.test.ts）先于单一扩展名
  for (const [suffix, icon] of MAPPING.suffixes)
    if (n.endsWith(suffix)) return icon;
  const dot = n.lastIndexOf(".");
  if (dot > 0) {
    const ext = (MAPPING.exts as Record<string, string>)[n.slice(dot + 1)];
    if (ext) return ext;
  }
  return MAPPING.defaults.file;
}

/** 目录名 → 图标名：认得的目录名用专属文件夹图标，其余是通用文件夹；open 取展开的变体 */
export function dirIconName(name: string, open = false): string {
  const alias = (MAPPING.dirs as Record<string, string>)[lower(name)];
  const base = alias ? `folder-${alias}` : MAPPING.defaults.dir;
  const full = open ? `${base}-open` : base;
  return (MAPPING.dirIcons as readonly string[]).includes(full)
    ? full
    : open
      ? `${MAPPING.defaults.dir}-open`
      : MAPPING.defaults.dir;
}
