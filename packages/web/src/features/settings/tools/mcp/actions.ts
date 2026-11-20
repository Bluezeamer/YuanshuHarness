import type { McpView } from "../../../../api/mcpLibrary";
import { notify } from "../../frame/notify";
import type { CheckSummary, McpStore } from "./store";

/** 检测汇总：就绪数 + 没通过的逐个点名原因。 */
export const summaryText = (s: CheckSummary) =>
  s.failed.length
    ? `检测完成：就绪 ${s.ready} / ${s.total}。${s.failed.map((f) => `${f.name}（${f.message}）`).join("、")}`
    : `检测完成：就绪 ${s.ready} / ${s.total}`;

/** 检测一次：通过返回 null，没通过（或请求没完成）返回原因。 */
export async function check(
  store: McpStore,
  name: string,
): Promise<string | null> {
  const r = await store.check(name);
  if (!r.ok) return r.message;
  return r.data.ok ? null : (r.data.handshake.error ?? "检测失败");
}

/** 保存配置或启用之后立刻检测一次（服务端保存配置会清掉握手结果），免得停在「未检测」。 */
export async function checkAfter(store: McpStore, name: string, lead: string) {
  const problem = await check(store, name);
  notify(
    problem === null ? null : `${lead}，但检测未通过：${problem}`,
    `${lead}，检测通过`,
  );
}

export async function checkAll(store: McpStore) {
  const r = await store.checkAll();
  notify(r.ok ? null : r.message, r.ok ? summaryText(r.data) : "");
}

/** 向包源查已固定服务的最新版；没查到的点名原因。 */
export async function checkUpdates(store: McpStore) {
  const r = await store.checkUpdates();
  notify(
    r.failed.length
      ? `检查了 ${r.checked} 个已固定的服务，${r.failed.length} 个没查到：${r.failed
          .map((f) => `${f.name}（${f.message}）`)
          .join("、")}`
      : null,
    `检查完成：${r.checked} 个已固定的服务`,
  );
}

/** 启用 / 禁用；刚启用的立刻检测一次。 */
export async function toggleEnabled(store: McpStore, m: McpView) {
  const r = await store.setEnabled(m.name, !m.enabled);
  if (!r.ok) return notify(r.message, "");
  if (m.enabled) return notify(null, `${m.name} 已禁用`);
  await checkAfter(store, m.name, `${m.name} 已启用`);
}
