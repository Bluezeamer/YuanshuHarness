import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ContextMcp,
  getSessionContext,
  reloadSession,
} from "../../../api/flows";
import { loadToken } from "../../../api/http";
import { Button, Chip, Dot, InlineNotice, Loading, Modal } from "../../../ui";
import {
  MCP_STATE_TEXT,
  MCP_TONE,
  needsHostDeps,
  sortMcp,
  stillConnecting,
  whereText,
} from "./mcpModel";

const POLL_MS = 1200;
// 连接再慢也不会无限轮询：撑过这么久还在「连接中」就交给用户再点重载
const POLL_MAX = 40;

export type McpDialogProps = {
  sessionId: string;
  open: boolean;
  onClose: () => void;
};

// /mcp：本会话里每个 MCP 服务此刻的连接状态；依赖在主机上装好之后点「重载」重新连。
export function McpDialog({ sessionId, open, onClose }: McpDialogProps) {
  const [items, setItems] = useState<ContextMcp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const load = useCallback(async (): Promise<ContextMcp[] | null> => {
    const r = await getSessionContext(loadToken(), sessionId);
    if (!alive.current) return null;
    if (!r.ok) {
      setError("读取不到这个会话的 MCP 状态");
      return null;
    }
    setError(null);
    setItems(r.data.mcp);
    return r.data.mcp;
  }, [sessionId]);

  // 有「连接中」就隔一会儿再读，直到都有结果
  const settle = useCallback(
    async (left: number) => {
      const list = await load();
      if (list && stillConnecting(list) && left > 0)
        timer.current = setTimeout(() => void settle(left - 1), POLL_MS);
    },
    [load],
  );

  useEffect(() => {
    alive.current = true;
    if (!open) return;
    setItems(null);
    void settle(POLL_MAX);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, settle]);

  const reload = async () => {
    setBusy(true);
    setError(null);
    const r = await reloadSession(loadToken(), sessionId);
    setBusy(false);
    if (!r.ok) {
      setError(
        r.kind === "conflict"
          ? "会话正在运行，等这一轮结束再重载"
          : "重载失败，请稍后再试",
      );
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    void settle(POLL_MAX);
  };

  const sorted = sortMcp(items ?? []);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="MCP 服务"
      description="这个会话里各服务此刻的连接状态。"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void reload()}
          >
            重载
          </Button>
        </>
      }
    >
      <div className="ch-mcp">
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        {items === null && !error && <Loading>正在读取</Loading>}
        {items !== null && sorted.length === 0 && (
          <p className="t-aux ch-mcp-empty">
            这个会话没有用到 MCP
            服务。可以在设置的「工具与能力」里登记，再在工作区里勾选。
          </p>
        )}
        {sorted.length > 0 && (
          <ul className="ch-mcp-list">
            {sorted.map((m) => (
              <li key={m.name} className="ch-mcp-row" data-state={m.state}>
                <div className="ch-mcp-head">
                  <Dot size="sm" tone={MCP_TONE[m.state]} />
                  <span className="t-body ch-mcp-name">{m.name}</span>
                  {m.global && <Chip>全局</Chip>}
                  <span className="t-aux ch-mcp-state">
                    {MCP_STATE_TEXT[m.state]}
                    {m.state === "ready" && ` · ${m.tools} 个工具`}
                  </span>
                </div>
                <div className="t-aux ch-mcp-where">
                  运行位置：{whereText(m)}
                </div>
                {m.state === "pending" && (
                  <div className="t-aux ch-mcp-where">
                    这个会话开着的时候才登记的：发下一条消息或点「重载」时加载。
                  </div>
                )}
                {m.error && <pre className="t-mono ch-mcp-err">{m.error}</pre>}
              </li>
            ))}
          </ul>
        )}
        {needsHostDeps(sorted) && (
          <p className="t-aux ch-mcp-note">
            stdio 服务要的运行时（node、uv、docker
            等）需要在运行位置的主机上自行装好；装好后点「重载」。
          </p>
        )}
      </div>
    </Modal>
  );
}
