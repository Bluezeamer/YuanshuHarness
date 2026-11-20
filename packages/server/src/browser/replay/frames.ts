// 回放每步的画面文件：<dir>/<sessionId>/<stepId>.jpg。
// 会话「有这一步」由数据库确认（调用方先查行再读文件），这里只管目录与文件。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class FrameStore {
  constructor(private readonly dir: string) {}

  save(sessionId: string, stepId: number, jpeg: Buffer): void {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(sessionId, stepId), jpeg);
  }

  read(sessionId: string, stepId: number): Buffer | null {
    try {
      return readFileSync(this.file(sessionId, stepId));
    } catch {
      return null;
    }
  }

  /** 挤掉的旧步：缺的文件忽略。 */
  remove(sessionId: string, stepIds: number[]): void {
    for (const id of stepIds) rmSync(this.file(sessionId, id), { force: true });
  }

  removeSession(sessionId: string): void {
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.dir, sessionId);
  }

  private file(sessionId: string, stepId: number): string {
    return path.join(this.sessionDir(sessionId), `${stepId}.jpg`);
  }
}
