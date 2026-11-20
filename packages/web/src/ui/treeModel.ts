// Tree 的纯逻辑：节点表 → 可见的行（展开、排序）、落点判定。不碰 DOM，单测见 tree.test.ts。
// 节点用相对根的路径当 id（`产品/时间线`）；文件夹的 id 不带结尾斜杠。

export interface TreeNode {
  /** 相对根的路径，用 `/` 分段；整棵树里唯一 */
  id: string;
  kind: "folder" | "item";
  /** 显示名，缺省取路径最后一段 */
  label?: string;
}

export interface TreeRow {
  node: TreeNode;
  /** 嵌套深度，根下的是 0 */
  depth: number;
  /** 路径最后一段（行内改名时改的就是它） */
  name: string;
  /** 文件夹是否展开 */
  open: boolean;
  /** 文件夹里有没有东西（决定要不要画展开箭头） */
  hasChildren: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const leafOf = (id: string): string => id.slice(id.lastIndexOf("/") + 1);
export const parentOf = (id: string): string =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";

/** 同一层：文件夹在前、各自按名字排（与服务端索引的目录树一致，不做手动排序）。 */
function sorted(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) =>
    a.kind === b.kind
      ? cmp(leafOf(a.id), leafOf(b.id))
      : a.kind === "folder"
        ? -1
        : 1,
  );
}

/**
 * 展平成可见的行：只展开 open 里的文件夹。有 query 时按名字过滤，匹配的节点连同它的祖先文件夹都显示、
 * 且祖先强制展开（这时 open 不起作用）。
 */
export function flatten(
  nodes: readonly TreeNode[],
  open: ReadonlySet<string>,
  query = "",
): TreeRow[] {
  const q = query.trim().toLowerCase();
  const byParent = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const p = parentOf(n.id);
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  const labelOf = (n: TreeNode) => n.label ?? leafOf(n.id);
  // 有 query 时：自己名字匹配、或后代里有匹配的才保留
  const keep = new Set<string>();
  if (q !== "") {
    for (const n of nodes)
      if (labelOf(n).toLowerCase().includes(q)) {
        keep.add(n.id);
        for (let p = parentOf(n.id); p !== ""; p = parentOf(p)) keep.add(p);
      }
  }
  const out: TreeRow[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const n of sorted(byParent.get(parent) ?? [])) {
      if (q !== "" && !keep.has(n.id)) continue;
      const children = byParent.get(n.id) ?? [];
      const isOpen = n.kind === "folder" && (q !== "" || open.has(n.id));
      out.push({
        node: n,
        depth,
        name: leafOf(n.id),
        open: isOpen,
        hasChildren: children.length > 0,
      });
      if (isOpen) walk(n.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** 拖 dragged（一批节点 id）到文件夹 folder（"" 是根）里：每一个会去哪、挪完后的路径。 */
export function movesFor(
  dragged: readonly string[],
  folder: string,
): Array<{ id: string; to: string }> {
  return dragged.map((id) => ({
    id,
    to: folder === "" ? leafOf(id) : `${folder}/${leafOf(id)}`,
  }));
}

/**
 * 能不能落：不能落进自己或自己的子孙；已经在那个文件夹里的（挪了也没变）不算落点。
 * 业务的 canDrop 在这之后再判（比如重名）。
 */
export function dropAllowed(
  dragged: readonly string[],
  folder: string,
  kindOf: (id: string) => TreeNode["kind"] | undefined,
): boolean {
  if (dragged.length === 0) return false;
  for (const id of dragged) {
    if (
      kindOf(id) === "folder" &&
      (folder === id || folder.startsWith(`${id}/`))
    )
      return false;
  }
  return dragged.some((id) => parentOf(id) !== folder);
}

/** 多选拖拽时去掉被选中文件夹里的子孙（它们跟着文件夹一起走）。 */
export function topLevel(ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let p = parentOf(id); p !== ""; p = parentOf(p))
      if (set.has(p)) return false;
    return true;
  });
}

/** 点了行之后的键盘移动：在可见行里上下走。 */
export function stepIndex(
  rows: readonly TreeRow[],
  current: string | null,
  delta: 1 | -1,
): number {
  const at = rows.findIndex((r) => r.node.id === current);
  if (at < 0) return delta === 1 ? 0 : rows.length - 1;
  return Math.min(rows.length - 1, Math.max(0, at + delta));
}
