// 终端管理：列出服务端全部终端，让用户清理「没有任何 tab 引用」的孤儿（达到数量上限时尤其需要）。
// 只是内容组件，放进 Popover / Modal 由接线处决定。
import { useCallback, useEffect, useRef, useState } from "react";
import { loadToken } from "../../../../api/http";
import {
  closeTerminal,
  listTerminals,
  type TerminalStatus,
} from "../../../../api/terminals";
import {
  Button,
  Chip,
  ConfirmButton,
  Empty,
  InlineNotice,
  Table,
  Td,
  Th,
  toast,
} from "../../../../ui";
import { useLayoutState } from "../../layoutContext";
import "./terminal.css";
import { shortId } from "./types";

export interface TerminalManagerProps {
  /** 当前布局里所有 tab 引用着的终端 id（含其它 L1 容器里的）。 */
  referencedIds: ReadonlySet<string>;
  /** 关掉终端后的通知，调用方可借此刷新自己的状态。 */
  onClosed?: (id: string) => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "ok"; items: TerminalStatus[] }
  | { kind: "error"; message: string };

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};

export function TerminalManager({
  referencedIds,
  onClosed,
}: TerminalManagerProps) {
  const workspaceId = useLayoutState((s) => s.workspaceId);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const r = await listTerminals(loadToken());
    if (mine !== seq.current) return;
    setLoad(
      r.ok
        ? { kind: "ok", items: r.data }
        : { kind: "error", message: "无法获取终端列表" },
    );
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      seq.current++;
    };
  }, [refresh]);

  const close = async (id: string) => {
    setClosing((s) => new Set(s).add(id));
    const r = await closeTerminal(loadToken(), id);
    setClosing((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    // 404 说明已经没了，目的达到
    if (r.ok || r.kind === "not_found") onClosed?.(id);
    else toast(`关闭 #${shortId(id)} 失败`, { tone: "danger" });
    await refresh();
  };

  // 别的工作区的终端既不在这里列出来，也不参与孤儿判断
  const items =
    load.kind === "ok"
      ? load.items.filter(
          (t) => t.workspaceId === null || t.workspaceId === workspaceId,
        )
      : [];
  const orphans = items.filter((t) => !referencedIds.has(t.id)).length;

  return (
    <div className="ws-term-mgr">
      <div className="ws-term-mgr-bar t-aux">
        <span className="ws-term-mgr-count t-mono">
          {load.kind === "ok"
            ? `共 ${items.length} 个 · ${orphans} 个无引用`
            : "终端"}
        </span>
        <span className="ws-term-gap" />
        <Button size="sm" onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      {load.kind === "error" && (
        <InlineNotice tone="danger">{load.message}</InlineNotice>
      )}

      {load.kind === "ok" && items.length === 0 && (
        <Empty
          compact
          title="服务端没有终端"
          description="新建终端标签后会出现在这里"
        />
      )}

      {items.length > 0 && (
        <Table
          caption="服务端终端列表"
          widths={["14%", "36%", "10%", "17%", "23%"]}
        >
          <thead>
            <tr>
              <Th>终端</Th>
              <Th>环境 · 目录</Th>
              <Th align="end">附着</Th>
              <Th>创建于</Th>
              <Th align="end">状态</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => {
              const used = referencedIds.has(t.id);
              return (
                <tr key={t.id}>
                  <Td mono title={`${t.id}（${t.cols}×${t.rows}）`}>
                    <span className="ws-term-mgr-id t-mono">
                      #{shortId(t.id)}
                    </span>
                  </Td>
                  <Td truncate mono title={`${t.environmentId} · ${t.cwd}`}>
                    {t.environmentId} · {t.cwd}
                  </Td>
                  <Td align="end" mono>
                    {t.attached}
                  </Td>
                  <Td>{fmtTime(t.createdAt)}</Td>
                  <Td align="end">
                    {used ? (
                      <Chip tone="live" dot>
                        使用中
                      </Chip>
                    ) : (
                      <ConfirmButton
                        size="sm"
                        loading={closing.has(t.id)}
                        armedLabel={t.busy ? "确认（有进程）" : "确认关闭"}
                        onConfirm={() => void close(t.id)}
                      >
                        关闭
                      </ConfirmButton>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
