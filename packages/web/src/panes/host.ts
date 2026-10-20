import { useContext, useEffect, useState } from "react";
import {
  type EnvironmentInfo,
  listEnvironments,
  listWorkspaces,
  loadToken,
  type WorkspaceInfo,
} from "../api";
import { EnvContext, useBound } from "../layout/env";
import type { PaneBinding } from "../layout/types";

// pane 绑定到的主机：钉住的环境，否则取所绑会话的 workspace 所在环境，都没有时是本机。
export interface Host {
  // 环境与 workspace 列表已取到；error 时为 false，调用方不应在猜测的主机上动手（如开终端）。
  ready: boolean;
  error: boolean;
  sessionId: string | null;
  environmentId: string;
  environmentName: string;
  // workspace 目录，只在 workspace 与 environmentId 同属一个环境时给出。
  root: string | null;
}

interface Loaded {
  key: string | null;
  workspaces: WorkspaceInfo[];
  envs: EnvironmentInfo[];
}

export function useHost(binding: PaneBinding): Host {
  const env = useContext(EnvContext);
  const { sessionId, host: pinned } = useBound(binding);
  const workspaceId =
    env?.sessions.find((s) => s.id === sessionId)?.workspaceId ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null | undefined>(undefined);
  const hub = env?.hub;

  useEffect(() => {
    let alive = true;
    setFailed(undefined);
    const token = loadToken();
    void Promise.all([listWorkspaces(token), listEnvironments(token)]).then(
      ([w, e]) => {
        if (!alive) return;
        if (w.ok && e.ok) {
          setLoaded({ key: workspaceId, workspaces: w.data, envs: e.data });
          return;
        }
        if (
          (!w.ok && w.kind === "unauthorized") ||
          (!e.ok && e.kind === "unauthorized")
        )
          hub?.onUnauthorized();
        setFailed(workspaceId);
      },
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, hub]);

  const ready = loaded?.key === workspaceId && failed !== workspaceId;
  const ws = ready
    ? loaded.workspaces.find((w) => w.id === workspaceId)
    : undefined;
  const environmentId = pinned ?? ws?.environmentId ?? "local";
  return {
    ready,
    error: failed === workspaceId,
    sessionId,
    environmentId,
    environmentName:
      (ready && loaded.envs.find((e) => e.id === environmentId)?.name) ||
      environmentId,
    root: ws && ws.environmentId === environmentId ? ws.path : null,
  };
}
