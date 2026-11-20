// 控制台抽屉：当前页的控制台消息与失败请求。历史走接口，连接后新增的由页面流推来，合并后只显示一份。
import { useEffect, useMemo, useRef, useState } from "react";
import { type ConsoleEntry, getConsole } from "../../../../api/browser";
import { loadToken } from "../../../../api/http";
import { IconButton } from "../../../../ui";
import { CloseIcon } from "../../../../ui/icons";
import { mergeConsole } from "./model";

export interface ConsoleDrawerProps {
  workspaceId: string;
  pageId: string;
  /** 页面流连接后新增的条目 */
  live: readonly ConsoleEntry[];
  onClose(): void;
}

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

export function ConsoleDrawer({
  workspaceId,
  pageId,
  live,
  onClose,
}: ConsoleDrawerProps) {
  const [history, setHistory] = useState<ConsoleEntry[]>([]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setHistory([]);
    void getConsole(loadToken(), workspaceId, pageId).then((r) => {
      if (alive && r.ok) setHistory(r.data);
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, pageId]);

  const entries = useMemo(() => mergeConsole(history, live), [history, live]);
  // 新消息到了就滚到底：控制台是看最新的。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条数变了才滚
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  // 相同的消息折叠成一行 ×n：条数是出现次数之和，种数是行数。
  const total = entries.reduce((n, e) => n + e.count, 0);

  return (
    <section className="ws-wb-con" aria-label="控制台">
      <div className="ws-wb-con-head t-aux">
        <span>
          控制台 · {total} 条
          {total === entries.length ? "" : ` · ${entries.length} 种`}
        </span>
        <IconButton
          size="sm"
          label="收起控制台"
          icon={<CloseIcon size={12} />}
          onClick={onClose}
        />
      </div>
      <div ref={list} className="ws-wb-con-list t-mono">
        {entries.length === 0 ? (
          <span className="ws-wb-con-time">没有消息</span>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              className="ws-wb-con-line"
              data-level={e.level}
              data-kind={e.kind}
            >
              <span className="ws-wb-con-time">{clock(e.ts)}</span>
              {e.count > 1 && (
                <span className="ws-wb-con-time">×{e.count}</span>
              )}
              <span>
                {e.kind === "request-failed" ? "[请求失败] " : ""}
                {e.text}
                {e.url && e.kind !== "request-failed" ? `  ${e.url}` : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
