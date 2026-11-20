// 对话标签要的会话元信息（标题、状态、agent 现在工作的目录）与主机展示名：桌面壳与手机端共用这一份。
import { useCallback, useMemo } from "react";
import type { ChatTabEnv, SessionMeta } from "../../features/chat/tab";
import type { HostInfo } from "../../features/workspace/layoutContext";
import { useLibraryState } from "../../features/workspace/library/LibraryProvider";
import { hostIdOf } from "./hosts";

export function useChatMeta(hosts: readonly HostInfo[]): {
  /** 提供给 ChatTabContext */
  env: ChatTabEnv;
  hostLabel(environmentId: string): string;
} {
  const sessions = useLibraryState((s) => s.sessions);
  const workspaces = useLibraryState((s) => s.workspaces);
  const titleOf = useMemo(
    () => new Map(sessions.map((s) => [s.id, s] as const)),
    [sessions],
  );
  const hostLabel = useCallback(
    (environmentId: string) =>
      hosts.find((h) => h.id === hostIdOf(environmentId))?.name ??
      environmentId,
    [hosts],
  );
  const directoryById = useMemo(
    () =>
      new Map(workspaces.flatMap((w) => w.directories).map((d) => [d.id, d])),
    [workspaces],
  );
  const env = useMemo<ChatTabEnv>(
    () => ({
      meta: (id: string): SessionMeta | undefined => {
        const s = titleOf.get(id);
        if (!s) return undefined;
        // agent 现在工作的目录：会话的当前目录 → 在哪台主机、哪个路径
        const d = s.directoryId ? directoryById.get(s.directoryId) : undefined;
        return {
          title: s.title,
          agentName: "agent",
          status: s.status,
          ...(d
            ? {
                place: {
                  host: hostIdOf(d.environmentId),
                  hostName: hostLabel(d.environmentId),
                  path: d.path,
                },
              }
            : {}),
        };
      },
    }),
    [titleOf, directoryById, hostLabel],
  );
  return { env, hostLabel };
}
