import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionView } from "../../../api/connections";
import { type MenuItem, toast } from "../../../ui";
import { deleteGuard, sshCommand } from "./model";
import {
  createRemoteStore,
  mountsOf,
  type RemoteState,
  type RemoteStore,
} from "./store";

/** 页面级 store：挂载时加载并接上进行中的激活，卸载时停轮询。 */
export function useRemote(injected?: RemoteStore) {
  const [store] = useState(() => injected ?? createRemoteStore());
  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, state };
}

export type Ready = Extract<RemoteState, { phase: "ready" }>;

/** 复制到剪贴板；不可用时（非安全上下文）给出提示而不是静默失败。 */
export async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, { tone: "ok" });
  } catch {
    toast("浏览器不允许写入剪贴板，请手动选中复制", { tone: "warn" });
  }
}

/** 连接的「⋯」菜单：左列表的行与详情头共用。删除被守卫挡住时置灰并写原因。 */
export function connMenu(
  c: ConnectionView,
  state: Ready,
  onRemove: (c: ConnectionView) => void,
): MenuItem[] {
  const { blocked } = deleteGuard(c, mountsOf(state, c.id).directories.length);
  return [
    {
      id: "ssh",
      label: "复制 ssh 命令",
      onSelect: () =>
        void copyText(sshCommand(c, state.conns), "已复制 ssh 命令"),
    },
    {
      id: "remove",
      label: "删除连接",
      tone: "danger",
      separatorBefore: true,
      disabled: blocked !== null,
      ...(blocked ? { hint: blocked } : {}),
      onSelect: () => onRemove(c),
    },
  ];
}
