// 测试临时目录的登记处：建目录时登记，所在测试文件跑完统一删。
// 以前这些目录建了就不管，几天攒出十几万个，把 /tmp 的 inode 占满（mkdtemp 报 ENOSPC，全量测试随机失败）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const made: string[] = [];

/** 在系统临时目录下建一个目录；这个测试文件结束时自动删掉 */
export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
