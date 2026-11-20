import { type ReactNode, useMemo, useRef } from "react";
import {
  type DirectoryChoice,
  type HostInfo,
  LayoutProvider,
  type RunState,
} from "./layoutContext";
import {
  useCurrentWorkspace,
  useLibraryState,
  useWorkspaceSessions,
} from "./library/LibraryProvider";
import type { Directory } from "./model/l2";
import type { LayoutStore, SessionBrief } from "./store/layoutStore";

/** 内容没变就沿用上一次的引用：LayoutProvider 按引用同步给 store，库数据每次重取都是新对象 */
function useStable<T>(value: T): T {
  const ref = useRef(value);
  if (JSON.stringify(ref.current) !== JSON.stringify(value))
    ref.current = value;
  return ref.current;
}

export interface LayoutBridgeProps {
  token: string | null;
  /** 注入现成的布局 store（测试用） */
  store?: LayoutStore;
  hosts: readonly HostInfo[];
  /** 服务端的环境 id → 布局里的主机 id（Server 本机在布局里叫 server） */
  toHostId(environmentId: string): string;
  children: ReactNode;
}

/**
 * 库数据与布局之间的胶水：当前工作区 → 布局 store 载哪一份文档，
 * 它的目录清单与会话列表随库数据同步给布局 store（后者据此补默认窗口、收敛失效的标签）。
 */
export function LayoutBridge({
  token,
  store,
  hosts,
  toHostId,
  children,
}: LayoutBridgeProps) {
  const current = useCurrentWorkspace();
  const workspace = useLibraryState((s) =>
    s.workspaces.find((w) => w.id === current.id),
  );
  const ready = useLibraryState((s) => s.ready);
  const sessions = useWorkspaceSessions(current.id);
  const all = useLibraryState((s) => s.sessions);

  const directories = useStable<Directory[] | null>(
    useMemo(
      () =>
        workspace?.directories.map((d) => ({
          host: toHostId(d.environmentId),
          path: d.path,
        })) ?? null,
      [workspace, toHostId],
    ),
  );
  const directoryChoices = useStable<DirectoryChoice[]>(
    useMemo(
      () =>
        workspace?.directories.map((d) => ({ id: d.id, name: d.name })) ?? [],
      [workspace],
    ),
  );
  const briefs = useStable<SessionBrief[] | null>(
    useMemo(
      () =>
        ready
          ? sessions.map((s) => ({
              id: s.id,
              updatedAt: s.updatedAt,
              archived: s.lifecycle === "archived",
            }))
          : null,
      [ready, sessions],
    ),
  );

  // 标题是展示数据，不进布局 store；按内容稳定，避免库每次重取都让标签条重渲染
  const titles = useStable<[string, string][]>(
    useMemo(() => all.map((s) => [s.id, s.title]), [all]),
  );
  const titleMap = useMemo(() => new Map(titles), [titles]);
  // 只收执行中与待处理的会话：待命的不画点，表也更稳
  const runStates = useStable<[string, RunState][]>(
    useMemo(
      () =>
        all.flatMap((s): [string, RunState][] =>
          s.status === "running" || s.status === "blocked"
            ? [[s.id, s.status]]
            : [],
        ),
      [all],
    ),
  );
  const runStateMap = useMemo(() => new Map(runStates), [runStates]);

  return (
    <LayoutProvider
      token={token}
      titles={titleMap}
      runStates={runStateMap}
      {...(store ? { store } : {})}
      workspaceId={current.id}
      directories={directories}
      directoryChoices={directoryChoices}
      sessions={briefs}
      hosts={hosts}
    >
      {children}
    </LayoutProvider>
  );
}
