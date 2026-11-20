import type { PluginView } from "../../../../api/pluginLibrary";
import { notify } from "../../frame/notify";
import { nameOf } from "./model";
import type { PluginStore } from "./store";

/** 启用 / 停用：立即动作，结果弹提示。提醒只对新会话或重载后的会话生效。 */
export async function toggleEnabled(store: PluginStore, p: PluginView) {
  const r = await store.setEnabled(p.source, !p.enabled);
  if (!r.ok) return notify(r.message, "");
  notify(
    null,
    `${nameOf(p.source)} 已${p.enabled ? "停用" : "启用"}，新会话或重载后生效`,
  );
}
