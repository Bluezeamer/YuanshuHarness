import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConnectionView,
  getConnectionLog,
  LOG_TYPES,
  type LogType,
} from "../../../api/connections";
import { loadToken } from "../../../api/http";
import {
  Button,
  Dot,
  Empty,
  FilterChip,
  fmtDateTime,
  InlineNotice,
  Loading,
  Table,
  Td,
  Th,
} from "../../../ui";
import { describeError } from "./errors";
import {
  LOG_LABEL,
  LOG_TONE,
  type LogRow,
  logCounts,
  mergeLogs,
} from "./model";

const PAGE = 50;
type Filter = LogType | "all";

interface LogState {
  rows: LogRow[];
  /** 每条连接的下一页游标；null 表示没有更早的了。 */
  cursors: Record<string, number | null>;
  loading: boolean;
  error: string | null;
}

// 各连接的日志在服务端是分开的，这里并发取回再按时间合并。
function useLogs(conns: readonly ConnectionView[]) {
  const [state, setState] = useState<LogState>({
    rows: [],
    cursors: {},
    loading: true,
    error: null,
  });
  const ids = conns.map((c) => c.id).join("\n");
  // 状态变了（掉线、激活结束）服务端就多了日志，重取一次；轮询里状态没变不会触发
  const states = conns.map((c) => c.status).join("\n");
  // 名称只用来标注行；放进 ref，连接状态刷新（激活轮询）时不会触发重取
  const labels = useRef(new Map<string, string>());
  labels.current = new Map(conns.map((c) => [c.id, c.label]));

  const fetchPages = useCallback(
    async (targets: { id: string; before?: number }[], append: boolean) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      const token = loadToken();
      const results = await Promise.allSettled(
        targets.map(async (t) => ({
          id: t.id,
          page: await getConnectionLog(token, t.id, {
            limit: PAGE,
            ...(t.before === undefined ? {} : { before: t.before }),
          }),
        })),
      );
      setState((s) => {
        const rows = append ? [...s.rows] : [];
        const cursors = append ? { ...s.cursors } : {};
        let error: string | null = null;
        for (const r of results) {
          if (r.status === "rejected") {
            error = describeError(r.reason).message;
            continue;
          }
          const { id, page } = r.value;
          cursors[id] = page.nextBefore;
          for (const e of page.log)
            rows.push({
              ...e,
              connectionId: id,
              connection: labels.current.get(id) ?? id,
            });
        }
        return { rows: mergeLogs(rows), cursors, loading: false, error };
      });
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: states 只用来在连接状态变化时重取
  useEffect(() => {
    void fetchPages(ids ? ids.split("\n").map((id) => ({ id })) : [], false);
  }, [ids, states, fetchPages]);

  const older = Object.entries(state.cursors).flatMap(([id, before]) =>
    before === null ? [] : [{ id, before }],
  );
  return {
    ...state,
    hasMore: older.length > 0,
    loadMore: () => void fetchPages(older, true),
  };
}

/** 连接日志：服务端审计里的 env 事件，按类别筛选，可加载更早的。 */
export function LogTab({ conns }: { conns: readonly ConnectionView[] }) {
  const log = useLogs(conns);
  const [filter, setFilter] = useState<Filter>("all");
  const counts = logCounts(log.rows);
  const shown =
    filter === "all" ? log.rows : log.rows.filter((r) => r.type === filter);
  return (
    <>
      <fieldset className="st-rc-chips">
        <legend className="sr-only">按类别筛选</legend>
        {(["all", ...LOG_TYPES] as const).map((t) => (
          <FilterChip
            key={t}
            pressed={filter === t}
            count={counts[t]}
            onClick={() => setFilter(t)}
          >
            {t === "all" ? "全部" : LOG_LABEL[t]}
          </FilterChip>
        ))}
      </fieldset>
      {log.error && (
        <InlineNotice tone="danger" className="st-rc-err">
          {log.error}
        </InlineNotice>
      )}
      {log.loading && log.rows.length === 0 ? (
        <Loading>正在读取日志…</Loading>
      ) : shown.length === 0 ? (
        <Empty
          title="这个筛选下还没有事件"
          description="激活、断开与失败都会写入服务端审计。"
        />
      ) : (
        <Table caption="连接日志" widths={["16%", "12%", "18%", "54%"]}>
          <thead>
            <tr>
              <Th>时间</Th>
              <Th>类型</Th>
              <Th>连接</Th>
              <Th>事件</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.connectionId}:${r.id}`}>
                <Td mono>{fmtDateTime(r.at) || "—"}</Td>
                <Td>
                  <span className="st-rc-logtype">
                    <Dot tone={LOG_TONE[r.type]} />
                    {LOG_LABEL[r.type]}
                  </span>
                </Td>
                <Td>{r.connection}</Td>
                <Td>
                  {r.text}
                  {r.detail && (
                    <span className="st-rc-logdetail t-mono">{r.detail}</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {log.hasMore && (
        <div className="st-rc-more">
          <Button
            variant="outline"
            loading={log.loading}
            onClick={log.loadMore}
          >
            加载更早的
          </Button>
        </div>
      )}
    </>
  );
}
