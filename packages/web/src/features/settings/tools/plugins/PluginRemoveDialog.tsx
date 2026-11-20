import { useState } from "react";
import type { PluginView } from "../../../../api/pluginLibrary";
import { ConfirmDialog } from "../../../../ui";
import { kindOf, nameOf } from "./model";
import type { PluginStore } from "./store";

// 卸载二次确认：写明影响范围。npm / git 来源会删掉装到本机的包体，本地目录来源只去登记、不动你的目录（pi 的 remove 就是这么做的）。
export function PluginRemoveDialog({
  plugin,
  store,
  onDone,
  onClose,
}: {
  plugin: PluginView;
  store: PluginStore;
  onDone: (name: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = nameOf(plugin.source);
  const local = kindOf(plugin.source) === "local";

  const run = async () => {
    setBusy(true);
    const r = await store.remove(plugin.source);
    setBusy(false);
    return r.ok ? onDone(name) : setError(r.message);
  };

  return (
    <ConfirmDialog
      open
      title={`卸载 ${name}`}
      confirmLabel="卸载"
      busy={busy}
      error={error}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>
        {local
          ? "会从 pi 的登记里去掉它；这是本地目录，目录本身不会删。"
          : "会从 pi 的登记里去掉它，并删除装到本机的包体。"}
        之后新会话不再带它的工具，正在跑的会话在重载前不变。
      </p>
    </ConfirmDialog>
  );
}
