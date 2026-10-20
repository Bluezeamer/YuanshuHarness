import { useEffect, useRef, useState } from "react";
import { enc, loadToken } from "../api";
import { useBound } from "../layout/env";
import type { PaneProps } from "../layout/types";

// 侧边浏览器跟着所绑定的会话走，自己没有需要持久化的配置。
export type BrowserLiveConfig = Record<string, never>;

interface State {
  available: boolean;
  hint: string | null;
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
}

const INITIAL: State = {
  available: false,
  hint: null,
  active: false,
  url: "",
  title: "",
  loading: false,
};

// 远端 Server 通知的状态，从 WS 流里逐条覆盖本地 state。
interface Notice {
  type: "state";
  available: boolean;
  hint: string | null;
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
}

function openBrowserStream(sessionId: string, token: string | null): WebSocket {
  const url = new URL(
    `/api/v1/sessions/${enc(sessionId)}/browser/stream`,
    location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    url.toString(),
    token ? ["yuanshu.v1", `bearer.${token}`] : ["yuanshu.v1"],
  );
  ws.binaryType = "arraybuffer";
  return ws;
}

async function requestRelease(
  token: string | null,
  sessionId: string,
): Promise<void> {
  try {
    await fetch(`/api/v1/sessions/${enc(sessionId)}/browser`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    // 关闭请求失败不阻塞；timeout 回收会兜底
  }
}

const btn =
  "grid size-6 place-items-center rounded-md text-mute hover:bg-line2 hover:text-ink";

export function BrowserLivePane({ binding }: PaneProps<BrowserLiveConfig>) {
  const { sessionId: sid } = useBound(binding);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<State>(INITIAL);
  const [dropped, setDropped] = useState(false);

  useEffect(() => {
    if (!sid) return;
    let alive = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setDropped(false);
    setState(INITIAL);

    const connect = () => {
      if (!alive) return;
      const token = loadToken();
      ws = openBrowserStream(sid, token);
      ws.onmessage = (e) => {
        if (!alive) return;
        if (typeof e.data === "string") {
          try {
            const n = JSON.parse(e.data) as Notice;
            if (n.type === "state")
              setState((s) => ({
                ...s,
                available: n.available,
                hint: n.hint,
                active: n.active,
                url: n.url,
                title: n.title,
                loading: n.loading,
              }));
          } catch {}
        } else if (e.data instanceof ArrayBuffer && canvasRef.current) {
          const jpeg = new Blob([e.data], { type: "image/jpeg" });
          createImageBitmap(jpeg)
            .then((bm) => {
              const canvas = canvasRef.current;
              if (!canvas || !alive) return;
              const ctx = canvas.getContext("2d");
              if (!ctx) return;
              canvas.width = bm.width;
              canvas.height = bm.height;
              ctx.drawImage(bm, 0, 0);
              bm.close();
            })
            .catch(() => {});
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        ws = null;
        setDropped(true);
        clearTimeout(retry);
        retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        ws?.close();
      };
    };
    connect();

    return () => {
      alive = false;
      clearTimeout(retry);
      ws?.close();
    };
  }, [sid]);

  const close = () => {
    if (!sid) return;
    void requestRelease(loadToken(), sid);
    setState(INITIAL);
  };

  if (!sid) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-mute">
        <p>
          钉住到会话后显示该会话的侧边浏览器，agent 操作的页面会实时展示在这里。
        </p>
      </div>
    );
  }

  if (!state.available && state.hint) {
    return (
      <div className="grid h-full place-items-center p-4 text-center">
        <div>
          <p className="mb-2 text-sm text-danger">浏览器不可用</p>
          <p className="text-xs text-mute">{state.hint}</p>
        </div>
      </div>
    );
  }

  if (!state.active) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-mute">
        <p className="text-xs">
          等待 agent 调用 browser_open 打开页面
          {dropped && "（连接已断开，重连中…）"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex items-center gap-2 border-b border-line bg-line2 px-2.5 py-1.5">
        <div className="flex gap-1">
          <button
            type="button"
            className={btn}
            title="关闭页面"
            onClick={close}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              className="size-3"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 py-0.5 text-xs font-mono text-mute">
          <span className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
            {state.title || "（无标题）"}
            {state.url && ` — ${state.url}`}
          </span>
        </div>
        {state.loading && <span className="text-xs text-mute">加载中…</span>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto">
        <canvas
          ref={canvasRef}
          className="absolute left-0 top-0 h-auto max-w-full"
        />
        {dropped && (
          <div className="absolute left-0 top-0 flex size-full items-center justify-center bg-bg/50 text-xs text-danger">
            连接已断开，重连中…
          </div>
        )}
      </div>
    </div>
  );
}
