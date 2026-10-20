import { useContext, useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "./api";
import { EnvContext, type WorkbenchEnv } from "./layout/env";
import { defaultRegistry } from "./layout/panes";
import type { PaneBinding } from "./layout/types";
import { SessionHub } from "./sessions/hub";

// 「链接应用」：把单个 pane 以无 chrome 的独立窗口打开，地址形如
//   /#/app/<pane类型>?s=<会话id>&c=<配置JSON的base64url>
// 放在 hash 里：不发给服务端，会话 id 与配置不会进访问日志；也不改动现有 pathname 路由。
export interface AppLink {
  type: string;
  sessionId: string | null;
  config: unknown | null;
}

const PREFIX = "#/app/";

const b64 = {
  enc: (v: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  dec: (s: string): unknown => {
    const raw = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))),
    );
  },
};

export function parseAppLink(hash: string): AppLink | null {
  if (!hash.startsWith(PREFIX)) return null;
  const [path = "", query = ""] = hash.slice(PREFIX.length).split("?", 2);
  const type = decodeURIComponent(path);
  if (!type) return null;
  const q = new URLSearchParams(query);
  let config: unknown | null = null;
  const c = q.get("c");
  if (c) {
    try {
      config = b64.dec(c);
    } catch {
      return { type, sessionId: q.get("s"), config: undefined };
    }
  }
  return { type, sessionId: q.get("s"), config };
}

export function buildAppLink(
  type: string,
  sessionId: string | null,
  config: unknown,
): string {
  const q = new URLSearchParams();
  if (sessionId) q.set("s", sessionId);
  if (config && Object.keys(config as object).length > 0)
    q.set("c", b64.enc(config));
  const qs = q.toString();
  return `${PREFIX}${encodeURIComponent(type)}${qs ? `?${qs}` : ""}`;
}

// 新窗口里打开；noopener 切断与当前窗口的引用。
export function openAppWindow(
  type: string,
  sessionId: string | null,
  config: unknown,
): void {
  const url = new URL(location.href);
  url.hash = buildAppLink(type, sessionId, config);
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

function Notice({ children }: { children: string }) {
  return (
    <div
      role="alert"
      className="grid h-full place-items-center p-7 text-center text-sm text-mute"
    >
      <p>{children}</p>
    </div>
  );
}

export function AppView({
  link,
  sessions,
  onUnauthorized,
  hub: given,
}: {
  link: AppLink;
  sessions: SessionInfo[];
  onUnauthorized: () => void;
  hub?: SessionHub;
}) {
  const registry = useMemo(() => defaultRegistry(), []);
  const [hub] = useState(() => given ?? new SessionHub());
  useEffect(() => {
    hub.onUnauthorized = onUnauthorized;
  }, [hub, onUnauthorized]);
  const outer = useContext(EnvContext);
  const type = registry.get(link.type);
  const [config, setConfig] = useState<unknown>(() =>
    link.config === null ? type?.defaultConfig() : link.config,
  );

  const env = useMemo<WorkbenchEnv>(
    () => outer ?? { hub, sessions, activeSessionId: link.sessionId },
    [outer, hub, sessions, link.sessionId],
  );

  if (!type) return <Notice>{`未知的应用类型「${link.type}」`}</Notice>;
  if (link.config === undefined)
    return <Notice>链接里的配置无法解析，请从原 pane 重新打开。</Notice>;

  const entry = { type: link.type, configVersion: type.configVersion, config };
  const resolved = registry.resolve(entry);
  if (!resolved)
    return <Notice>该应用的配置版本比当前 WebUI 新，请先升级。</Notice>;
  const binding: PaneBinding = link.sessionId
    ? { mode: "fixed", sessionId: link.sessionId, host: null }
    : { mode: "follow" };
  const Comp = type.component;

  return (
    <EnvContext.Provider value={env}>
      <main className="h-full min-h-0 bg-bg" data-app-view={link.type}>
        <Comp
          paneId={`app:${link.type}`}
          config={resolved.config as never}
          focused
          binding={binding}
          onUpdateConfig={(c: never) => setConfig(c)}
        />
      </main>
    </EnvContext.Provider>
  );
}
