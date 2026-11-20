// 技能与 MCP 的新版自动检查：首次进入页签、读完列表后在后台静默查一次，只刷新「可更新」的依据，
// 不弹提示、不更新任何东西。每类 6 小时内查过就不再查；全都没查到（多半没网）不记，下次进来再试。
import { localKey, readLocal, writeLocal } from "../../../../app/localState";

const INTERVAL_MS = 6 * 3600_000;
const keyOf = (kind: string) => localKey("tools.updateCheckedAt", kind);

/** 记下这一类刚查过。 */
export const markUpdatesChecked = (kind: "skills" | "mcp", now = Date.now()) =>
  writeLocal(keyOf(kind), now);

interface CheckResult {
  checked: number;
  failed: readonly unknown[];
}

export async function autoCheckUpdates(
  kind: "skills" | "mcp",
  run: () => Promise<CheckResult>,
  now = Date.now(),
): Promise<void> {
  const last = readLocal(keyOf(kind), (v) =>
    typeof v === "number" ? v : null,
  );
  if (last !== null && last > 0 && now - last < INTERVAL_MS) return;
  const r = await run();
  if (r.checked > 0 && r.failed.length < r.checked)
    markUpdatesChecked(kind, now);
}
