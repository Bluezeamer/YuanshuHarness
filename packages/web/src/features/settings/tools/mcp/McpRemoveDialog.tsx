import { useState } from "react";
import type { McpView } from "../../../../api/mcpLibrary";
import { ConfirmDialog } from "../../../../ui";
import type { McpStore } from "./store";

// 卸载二次确认：写明影响范围——会断开实例并删除这条登记，环境里的文件不会删。
export function McpRemoveDialog({
  servers,
  store,
  onDone,
  onClose,
}: {
  servers: readonly McpView[];
  store: McpStore;
  /** 成功卸载的名称，以及失败说明。 */
  onDone: (removed: string[], problems: string | null) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = servers.length === 1 ? servers[0] : undefined;

  const run = async () => {
    setBusy(true);
    if (one) {
      const r = await store.remove(one.name);
      setBusy(false);
      return r.ok ? onDone([one.name], null) : setError(r.message);
    }
    const r = await store.batch(
      servers.map((s) => s.name),
      "uninstall",
    );
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const bad = r.data.items.filter((i) => !i.ok);
    onDone(
      r.data.items.filter((i) => i.ok).map((i) => i.name),
      bad.length
        ? bad.map((i) => `${i.name}：${i.message ?? i.error}`).join("；")
        : null,
    );
  };

  return (
    <ConfirmDialog
      open
      title={one ? `卸载 ${one.name}` : `卸载 ${servers.length} 个服务`}
      confirmLabel="卸载"
      busy={busy}
      error={error}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>
        {one
          ? "会断开它的实例并删除这条登记，之后新会话不再带它的工具。"
          : `${servers.length} 个服务会断开实例并删除登记，之后新会话不再带它们的工具。`}
        环境里的文件不会删。
      </p>
    </ConfirmDialog>
  );
}
