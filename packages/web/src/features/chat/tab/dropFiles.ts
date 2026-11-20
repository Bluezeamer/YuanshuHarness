// 拖拽附件：把一次 DataTransfer 展开成文件清单。
// 文件夹走 webkitGetAsEntry() 递归（逐批 readEntries 到空数组为止）；items 不可用时回退 files。
// 两个使用方：对话标签的附件上传只要文件本身；文件浏览器的外部拖入还要相对路径（还原目录结构）。

/** webkitGetAsEntry() 返回的最小结构；用假 entry 就能单测目录递归 */
export interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (file: File) => void, fail?: (err: unknown) => void): void;
  createReader?(): DropReader;
}

export interface DropReader {
  /** 浏览器分批返回目录内容，空数组表示读完（Chrome 每批最多 100 条） */
  readEntries(
    ok: (entries: DropEntry[]) => void,
    fail?: (err: unknown) => void,
  ): void;
}

export interface DropItem {
  kind: string;
  webkitGetAsEntry?(): DropEntry | null;
}

/** DataTransfer 的最小结构：只用到 items / files，方便单测用假对象 */
export interface DropTransfer {
  items?: ArrayLike<DropItem> | null;
  files?: ArrayLike<File> | null;
}

export interface DroppedFile {
  file: File;
  /** 含目录的相对路径（附件只用来去重；文件浏览器上传时按它还原目录结构） */
  path: string;
}

/** 读单个文件 entry；读不出来（已删除、无权限）时跳过，不阻塞整批 */
function readFile(entry: DropEntry, path: string): Promise<DroppedFile[]> {
  return new Promise((resolve) => {
    if (!entry.file) {
      resolve([]);
      return;
    }
    entry.file(
      (file) => resolve([{ file, path }]),
      () => resolve([]),
    );
  });
}

/** 递归展开目录：子项路径拼在目录名后，逐批读到空数组为止 */
async function readDirectory(
  entry: DropEntry,
  path: string,
): Promise<DroppedFile[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const out: DroppedFile[] = [];
  for (;;) {
    const batch = await new Promise<DropEntry[]>((resolve) => {
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve([]),
      );
    });
    if (batch.length === 0) return out;
    const files = (
      await Promise.all(batch.map((e) => readEntry(e, path)))
    ).flat();
    out.push(...files);
  }
}

/** 展开一个 entry：目录按名字拼相对路径，文件带自身 path */
function readEntry(entry: DropEntry, base = ""): Promise<DroppedFile[]> {
  const path = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isDirectory) return readDirectory(entry, path);
  if (entry.isFile) return readFile(entry, path);
  return Promise.resolve([]);
}

/** 从 items 里取 entry；拿不到（浏览器不支持或权限受限）就交给 files 兜底 */
function entriesOf(dt: DropTransfer): DropEntry[] {
  if (!dt.items) return [];
  const entries: DropEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  return entries;
}

/** 系统文件拖拽（文件夹的 types 里也带 Files）；标签/文字等内部拖拽不接管 */
export const isFileDrag = (dt: { types?: ArrayLike<string> } | null): boolean =>
  Array.from(dt?.types ?? []).includes("Files");

/** 一次拖放 → 去重后的文件清单（含相对路径）；文件夹里的文件递归展开，附件名由服务端决定 */
export async function droppedFilesWithPaths(
  dt: DropTransfer | null,
): Promise<DroppedFile[]> {
  if (!dt) return [];
  const entries = entriesOf(dt);
  const files =
    entries.length > 0
      ? (await Promise.all(entries.map((e) => readEntry(e)))).flat()
      : Array.from(dt.files ?? []).map((file) => ({
          file,
          path: file.name,
        }));
  const seen = new Set<string>();
  const out: DroppedFile[] = [];
  for (const f of files) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}

/** 附件上传只要文件本身：相对路径在这里丢掉 */
export async function droppedFiles(dt: DropTransfer | null): Promise<File[]> {
  return (await droppedFilesWithPaths(dt)).map((f) => f.file);
}
