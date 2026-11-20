// 目录路径的纯函数。只处理 posix 风格（会话目录目前只有 posix 主机）。

export const isAbsolute = (p: string): boolean => p.trim().startsWith("/");

/** 去首尾空白、合并重复斜杠、去掉末尾斜杠（根除外） */
export const normDir = (p: string): string => {
  const t = p.trim();
  if (!t) return "";
  const s = t.replace(/\/{2,}/g, "/");
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};

export const parentOf = (dir: string): string => {
  const i = dir.lastIndexOf("/");
  return i <= 0 ? "/" : dir.slice(0, i);
};

export const joinPath = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** 面包屑：根 + 每一层，最后一段标记 last */
export const crumbsOf = (
  dir: string,
): { path: string; label: string; last: boolean }[] => {
  const parts = normDir(dir).split("/").filter(Boolean);
  const out = [{ path: "/", label: "/", last: parts.length === 0 }];
  let acc = "";
  parts.forEach((name, i) => {
    acc += `/${name}`;
    out.push({ path: acc, label: name, last: i === parts.length - 1 });
  });
  return out;
};

/** 自身与全部上级，由近及远：/a/b → /a/b、/a、/ */
export const selfAndAncestors = (dir: string): string[] => {
  const out: string[] = [];
  let cur = normDir(dir) || "/";
  for (;;) {
    out.push(cur);
    if (cur === "/") return out;
    cur = parentOf(cur);
  }
};
