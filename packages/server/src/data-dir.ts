import { randomBytes } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// 数据目录不存在就创建（0700），然后确认能在里面创建文件。
// 用「创建再删除探测文件」而不是 access()：只读挂载与权限位的组合下后者可能与真实可写性不一致。
export async function prepareDataDir(dir: string): Promise<void> {
  try {
    // 已存在的目录 mkdir 不会改它的权限。
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`数据目录不可用：${dir}（${reason(err)}）`);
  }

  const probe = path.join(
    dir,
    `.write-probe-${randomBytes(6).toString("hex")}`,
  );
  try {
    await (await open(probe, "wx")).close();
  } catch (err) {
    throw new Error(`数据目录不可写：${dir}（${reason(err)}）`);
  } finally {
    await unlink(probe).catch(() => {});
  }
}
