// 终端标签与目录的接线：注册渲染器 + 关闭前的确认守卫 + 终端管理入口。
// P2a 的 store 动作是同步的；关闭终端要先探测/确认/杀服务端终端，所以在 store 之上包一层异步动作，
// TabBar / 窗格菜单 / 窗口条改调这里的 useGuardedActions()，不要直接调 store.closeTab 等。
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Modal } from "../../../../ui";
import { useLayoutState, useLayoutStore } from "../../layoutContext";
import { findPane, panesOf } from "../../model/l2";
import type { Tab, WindowState } from "../../model/types";
import { registerTab, tabTypeLabel } from "../registry";
import { useTerminalCloseGuard } from "./close";
import { TerminalManager } from "./TerminalManager";
import { TerminalTab } from "./TerminalTab";

/** 当前工作区全部 term 标签引用着的终端 id（含其它窗口），供终端管理区分孤儿 */
export function referencedTermIds(st: WindowState): Set<string> {
  const ids = new Set<string>();
  for (const w of st.list)
    for (const p of panesOf(w))
      for (const t of p.tabs) if (t.termId) ids.add(t.termId);
  return ids;
}

const termTabsOf = (tabs: readonly Tab[]) =>
  tabs.filter((t) => t.type === "term");

export interface GuardedActions {
  /** 关标签：终端先确认并关掉服务端终端；返回是否真的关了 */
  closeTab(pid: string, tid: string): Promise<boolean>;
  /** 关窗格：窗格里所有终端一并确认 */
  closePane(pid: string): Promise<boolean>;
  /** 关窗口：窗口里所有窗格的终端一并确认 */
  closeWindow(index: number): Promise<boolean>;
  /** 打开终端管理（弹层由 Provider 渲染） */
  openManager(): void;
}

const GuardCtx = createContext<GuardedActions | null>(null);

export function TerminalGuardProvider({ children }: { children: ReactNode }) {
  const store = useLayoutStore();
  const wins = useLayoutState((s) => s.doc.windows);
  const { confirmClose, dialog } = useTerminalCloseGuard();
  const [managing, setManaging] = useState(false);

  const actions = useMemo<GuardedActions>(
    () => ({
      async closeTab(pid, tid) {
        const win = wins.list[wins.active];
        const tab = win && findPane(win, pid)?.tabs.find((t) => t.id === tid);
        if (tab && !(await confirmClose([tab]))) return false;
        return store.closeTab(pid, tid);
      },
      async closePane(pid) {
        const win = wins.list[wins.active];
        const pane = win && findPane(win, pid);
        if (pane && !(await confirmClose(termTabsOf(pane.tabs)))) return false;
        return store.closePane(pid);
      },
      async closeWindow(index) {
        const win = wins.list[index];
        const tabs = win ? panesOf(win).flatMap((p) => termTabsOf(p.tabs)) : [];
        if (!(await confirmClose(tabs))) return false;
        return store.closeWindow(index);
      },
      openManager: () => setManaging(true),
    }),
    [store, wins, confirmClose],
  );

  return (
    <GuardCtx.Provider value={actions}>
      {children}
      {dialog}
      <Modal
        open={managing}
        onClose={() => setManaging(false)}
        title="终端管理"
        description="服务端上全部终端。没有标签引用的终端可以在这里关闭。"
        size="lg"
      >
        {managing && (
          <TerminalManager referencedIds={referencedTermIds(wins)} />
        )}
      </Modal>
    </GuardCtx.Provider>
  );
}

export function useGuardedActions(): GuardedActions {
  const a = useContext(GuardCtx);
  if (!a) throw new Error("需要 <TerminalGuardProvider>");
  return a;
}

/** 在 <TerminalGuardProvider> 外也能用（测试与单独渲染标签）：退化为直接调 store */
export function useOptionalGuardedActions(): GuardedActions | null {
  return useContext(GuardCtx);
}

/** 关闭类动作的统一入口：有守卫就走确认，没有就直接调 store（同步结果包成 Promise） */
export function useCloseActions(): Pick<
  GuardedActions,
  "closeTab" | "closePane" | "closeWindow"
> {
  const store = useLayoutStore();
  const guard = useContext(GuardCtx);
  return useMemo(
    () =>
      guard ?? {
        closeTab: async (pid, tid) => store.closeTab(pid, tid),
        closePane: async (pid) => store.closePane(pid),
        closeWindow: async (i) => store.closeWindow(i),
      },
    [guard, store],
  );
}

/** 把 term 标签注册进标签注册表；应用启动时调用一次 */
export function registerTerminalTab(): void {
  registerTab("term", {
    icon: <TermIcon />,
    title: (tab) => (tab.cwd ? lastSegment(tab.cwd) : tabTypeLabel("term")),
    tip: (tab) => tab.cwd ?? "",
    render: (props) => <TermHost {...props} />,
  });
}

const lastSegment = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function TermIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10h2.5" />
    </svg>
  );
}

function TermHost(props: Parameters<typeof TerminalTab>[0]) {
  const guard = useOptionalGuardedActions();
  const onManage = useCallback(() => guard?.openManager(), [guard]);
  return <TerminalTab {...props} onManage={guard ? onManage : undefined} />;
}
