// 远程目录的画布在 Server 本机有一份权威副本，改动在后台推到远端；这里轮询推送状态给工具条显示。
// 状态只在「有东西没推过去」或「远端文件被外部改过已另存」时才露出来，平时看不见。
import { useEffect, useState } from "react";
import { type MirrorStatus, readMirror } from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";

const POLL_MS = 3000;
/** 再问也不会变的失败（没权限、目录没了）：不再轮询；网络与服务端的临时错误继续 */
const GIVE_UP = new Set([
  "unauthorized",
  "forbidden",
  "bad_request",
  "not_found",
]);

export interface SyncBadge {
  text: string;
  tip: string;
  busy: boolean;
}

export function syncBadge(s: MirrorStatus | null): SyncBadge | null {
  if (s === null) return null;
  const left = s.pending > 0 ? `（${s.pending} 项待推送）` : "";
  if (s.state === "offline")
    return {
      text: "远端未同步",
      tip: `远端暂时连不上${s.error ? `：${s.error}` : ""}。改动都留在元枢里，连上后会自动推送${left}`,
      busy: false,
    };
  if (s.state !== "synced")
    return {
      text: "同步到远端",
      tip: `正在把改动推到远端${left}`,
      busy: true,
    };
  if (s.asides.length > 0)
    return {
      text: `远端有 ${s.asides.length} 份改动已另存`,
      tip: `这些远端文件在元枢之外被改过，已另存为下列副本，原位置写入的是元枢里的版本：\n${s.asides.join("\n")}`,
      busy: false,
    };
  return null;
}

/** 没有副本（本机环境）时第一次就得到 null，之后不再轮询。 */
export function useRemoteSync(env: string, dir: string): MirrorStatus | null {
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const r = await readMirror(loadToken(), env, dir);
      if (!alive) return;
      const next = r.ok ? r.data : null;
      setStatus(next);
      if (r.ok ? next === null : GIVE_UP.has(r.kind)) return;
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [env, dir]);
  return status;
}
