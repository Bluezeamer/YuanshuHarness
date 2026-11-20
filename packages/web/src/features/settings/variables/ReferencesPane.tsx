import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { listDirectories } from "../../../api/directories";
import { loadToken } from "../../../api/http";
import { fetchReferences, type ReferenceView } from "../../../api/variables";
import {
  Button,
  Chip,
  DetailRow,
  Empty,
  FilterChip,
  Loading,
  Select,
  Table,
  Td,
  Th,
} from "../../../ui";
import { ChevronRightIcon, CloseIcon } from "../../../ui/icons";
import { describeError } from "./errors";
import { clock, RESULT_LABEL, type RefFilter, refPasses } from "./model";

const WIDTHS = ["12%", "20%", "20%", "34%", "14%"];
const TONE = { ok: "live", denied: "danger", expired: "warn" } as const;

export interface ReferencesPaneProps {
  /** 主机标识 → 环境显示名。 */
  hostLabel: (hostId: string) => string;
  /** 只看某个变量的记录（从变量详情的「查看记录」进来）；null = 全部。 */
  name: string | null;
  onClearName: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

// 引用记录：agent 主动发起的引用，归属到发起它的 directory。看值、复制、服务端自用、
// 增删轮换吊销都不进这张表（服务端只记引用，这里也没有对应入口）。
export function ReferencesPane({
  hostLabel,
  name,
  onClearName,
}: ReferencesPaneProps) {
  const [items, setItems] = useState<ReferenceView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState<RefFilter>("all");
  const [directory, setDirectory] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);

  // 只认最新一次请求：快速切换目录时，慢到的旧响应不能盖掉新结果
  const latest = useRef(0);
  const load = useCallback(async (ws: string, who: string | null) => {
    const mine = ++latest.current;
    setPhase({ kind: "loading" });
    try {
      const page = await fetchReferences(loadToken(), {
        ...(ws ? { directory: ws } : {}),
        ...(who ? { name: who } : {}),
      });
      if (mine !== latest.current) return;
      setItems(page.references);
      setNext(page.nextBefore);
      setSeen(
        (cur) =>
          new Set([...cur, ...page.references.map((r) => r.directoryId)]),
      );
      setPhase({ kind: "ready" });
    } catch (e) {
      if (mine === latest.current)
        setPhase({ kind: "error", message: describeError(e).message });
    }
  }, []);

  useEffect(() => {
    void load(directory, name);
  }, [load, directory, name]);

  useEffect(() => {
    void listDirectories(loadToken()).then((r) => {
      if (r.ok) setNames(Object.fromEntries(r.data.map((w) => [w.id, w.name])));
    });
  }, []);

  const loadMore = async () => {
    if (next === null) return;
    const mine = latest.current;
    setMore(true);
    try {
      const page = await fetchReferences(loadToken(), {
        before: next,
        ...(directory ? { directory } : {}),
        ...(name ? { name } : {}),
      });
      if (mine !== latest.current) return;
      setItems((cur) => [...cur, ...page.references]);
      setNext(page.nextBefore);
    } catch (e) {
      if (mine === latest.current)
        setPhase({ kind: "error", message: describeError(e).message });
    } finally {
      setMore(false);
    }
  };

  const wsName = (id: string) => names[id] ?? id;
  const wsIds = [...new Set([...Object.keys(names), ...seen])];
  const shown = items.filter((r) => refPasses(r, filter));
  const count = (f: RefFilter) => items.filter((r) => refPasses(r, f)).length;

  return (
    <div className="vr-refs">
      <header className="vr-refs-head">
        <span className="t-block">
          {phase.kind === "ready"
            ? `${items.length} 条记录${next !== null ? "（还有更早的）" : ""}`
            : "引用记录"}
        </span>
        <p className="t-aux">
          只记 agent
          发起的引用：目录、环境、命令与结论；命令保留占位符原文，值不落库。显示、复制、轮换值不计入。
        </p>
      </header>
      <div className="vr-filters">
        <FilterChip
          pressed={filter === "all"}
          count={count("all")}
          onClick={() => setFilter("all")}
        >
          全部
        </FilterChip>
        <FilterChip
          pressed={filter === "ok"}
          count={count("ok")}
          onClick={() => setFilter("ok")}
        >
          放行
        </FilterChip>
        <FilterChip
          pressed={filter === "fail"}
          count={count("fail")}
          onClick={() => setFilter("fail")}
        >
          拒绝
        </FilterChip>
        {name && (
          <Button
            size="sm"
            variant="outline"
            icon={<CloseIcon />}
            aria-label={`只看 ${name}，点击清除`}
            onClick={onClearName}
          >
            <span className="t-mono">{`{{@${name}}}`}</span>
          </Button>
        )}
        <Select
          aria-label="按目录筛选"
          className="vr-refs-dir"
          value={directory}
          options={[
            { value: "", label: "全部目录" },
            ...wsIds.map((id) => ({ value: id, label: wsName(id) })),
          ]}
          onChange={setDirectory}
        />
      </div>
      {phase.kind === "loading" ? (
        <Loading compact>正在读取引用记录…</Loading>
      ) : phase.kind === "error" ? (
        <Empty
          tone="danger"
          compact
          title="读取引用记录失败"
          description={phase.message}
          action={
            <Button onClick={() => void load(directory, name)}>重试</Button>
          }
        />
      ) : shown.length === 0 ? (
        <p className="vr-refs-none t-aux">这个筛选下还没有记录。</p>
      ) : (
        <Table widths={WIDTHS} caption="变量引用记录" className="vr-tbl">
          <thead>
            <tr>
              <Th>时间</Th>
              <Th>变量</Th>
              <Th>目录 · 环境</Th>
              <Th>命令（占位符原文）</Th>
              <Th>结果</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const open = openId === r.id;
              const toggle = () => setOpenId(open ? null : r.id);
              return (
                <Fragment key={r.id}>
                  <tr
                    className="vr-row"
                    data-ref={r.id}
                    aria-expanded={open}
                    tabIndex={0}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                  >
                    <Td mono>{clock(r.at)}</Td>
                    <Td mono>{`{{@${r.name}}}`}</Td>
                    <Td>
                      <div className="t-entry">{wsName(r.directoryId)}</div>
                      <div className="t-aux">{hostLabel(r.hostId)}</div>
                    </Td>
                    <Td mono truncate title={r.command}>
                      {r.command ?? "—"}
                    </Td>
                    <Td>
                      <span className="vr-res">
                        <Chip
                          {...(r.result in TONE
                            ? { tone: TONE[r.result as keyof typeof TONE] }
                            : {})}
                        >
                          {RESULT_LABEL[r.result]}
                        </Chip>
                        <ChevronRightIcon className="vr-chev" />
                      </span>
                    </Td>
                  </tr>
                  {open && (
                    <DetailRow colSpan={5}>
                      <dl className="vr-rdetail">
                        <div>
                          <dt className="t-mono">目录</dt>
                          <dd className="t-mono">{wsName(r.directoryId)}</dd>
                        </div>
                        <div>
                          <dt className="t-mono">环境</dt>
                          <dd className="t-mono">{hostLabel(r.hostId)}</dd>
                        </div>
                        <div>
                          <dt className="t-mono">执行</dt>
                          <dd className="t-mono">{r.runId ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="t-mono">工具调用</dt>
                          <dd className="t-mono">{r.toolCallId}</dd>
                        </div>
                        <div className="vr-rcmd">
                          <dt className="t-mono">命令</dt>
                          <dd className="t-mono">{r.command ?? "—"}</dd>
                        </div>
                      </dl>
                    </DetailRow>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}
      {phase.kind === "ready" && next !== null && (
        <div className="vr-more">
          <Button loading={more} onClick={() => void loadMore()}>
            加载更早的
          </Button>
        </div>
      )}
    </div>
  );
}
