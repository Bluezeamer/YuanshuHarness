// 缩略图文件：休眠前截一张 JPEG，唤醒前列表里能看到它。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export class ThumbStore {
  constructor(private readonly dir: string) {}

  save(pageId: string, jpeg: Buffer): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(pageId), jpeg);
  }

  has(pageId: string): boolean {
    return existsSync(this.file(pageId));
  }

  read(pageId: string): Buffer | null {
    try {
      return readFileSync(this.file(pageId));
    } catch {
      return null;
    }
  }

  remove(pageId: string): void {
    rmSync(this.file(pageId), { force: true });
  }

  /** 删掉不在 keep 里的文件（重启恢复、删工作区后用）。 */
  prune(keep: Set<string>): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const id = name.endsWith(".jpg") ? name.slice(0, -4) : null;
      if (id !== null && keep.has(id)) continue;
      rmSync(path.join(this.dir, name), { force: true });
    }
  }

  private file(pageId: string): string {
    return path.join(this.dir, `${pageId}.jpg`);
  }
}
