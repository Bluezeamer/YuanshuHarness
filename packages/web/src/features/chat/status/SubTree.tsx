import { Dot, fmtDateTime, ListRow, PeekCard, Segmented } from "../../../ui";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "../../../ui/icons";
import { execCtxText } from "../exec/execModel";
import { fmtDuration } from "../model/metrics";
import {
  agoText,
  countOf,
  isEnded,
  type SubNode,
  type SubStatus,
  splitKids,
} from "./subTree";

// 这块界面的状态：由面板持有（窄栏的卡片每次收起都会卸载，放在这里关了再开才不丢），随标签页保存。
export interface SubUi {
  /** 现状（结束够久的折起来）还是全部 */
  all: boolean;
  setAll(all: boolean): void;
  /** 展开了「已结束 N 个」的那些父节点 */
  open: ReadonlySet<string>;
  toggleOpen(parentId: string): void;
  /** 用户看过的失败节点：没看过的失败不折叠 */
  seen: ReadonlySet<string>;
  markSeen(id: string): void;
  now: number;
  onOpen(id: string): void;
}

export const STATUS_LABEL: Record<SubStatus, string> = {
  live: "运行中",
  idle: "未激活",
  ok: "已结束",
  error: "失败",
  stopped: "已中断",
};

export function StatusMark({ status }: { status: SubStatus }) {
  if (status === "ok") return <CheckIcon size={12} />;
  return (
    <Dot
      size="sm"
      tone={status === "live" ? "live" : status === "error" ? "danger" : "idle"}
      motion={status === "live" ? "pulse" : undefined}
    />
  );
}

// all：这一棵子树是用户点开「已结束 N 个」看的，要原样列全，不再二次折叠
function Row({ n, ui, all }: { n: SubNode; ui: SubUi; all?: boolean }) {
  const x = n.exec;
  const ended = isEnded(n.status);
  const unseenFail = n.status === "error" && !ui.seen.has(n.id);
  const since = Date.parse(x.since);
  const took = Number.isFinite(since)
    ? fmtDuration(Math.max(0, (n.endedAt ?? ui.now) - since))
    : "";
  const when = n.endedAt === null ? "" : agoText(ui.now - n.endedAt);
  return (
    <li className="ch-kid" data-subagent={n.id} data-status={n.status}>
      <ListRow
        size="compact"
        className={ended ? "ch-dimrow" : undefined}
        lead={<StatusMark status={n.status} />}
        label={x.name}
        trail={
          ended ? (
            <span className="t-aux">
              {n.status === "error" ? `失败 · ${when}` : when}
            </span>
          ) : (
            <span className="t-mono">{took}</span>
          )
        }
        onClick={() => {
          if (unseenFail) ui.markSeen(n.id);
          ui.onOpen(n.id);
        }}
        peek={
          <PeekCard
            title={x.name}
            text={x.task}
            facts={[
              ["状态", STATUS_LABEL[n.status]],
              ["角色", x.role],
              ["用时", took],
              ["上下文", execCtxText(x)],
              ...(n.endedAt === null
                ? []
                : ([["结束于", fmtDateTime(n.endedAt)]] as const)),
              ...(unseenFail
                ? ([["处理", "点一下标为已看，之后按时间折叠"]] as const)
                : []),
            ]}
          />
        }
      />
      <Kids parent={n} ui={ui} all={all ?? false} />
    </li>
  );
}

// 一个节点的子节点：现状视图把结束够久的收成末尾一行「已结束 N 个」，全部视图原样列出
function Kids({
  parent,
  ui,
  all,
}: {
  parent: SubNode;
  ui: SubUi;
  all: boolean;
}) {
  if (parent.kids.length === 0) return null;
  const { shown, folded, count, latest } = splitKids(
    parent.kids,
    !ui.all && !all,
    ui.seen,
    ui.now,
  );
  const open = ui.open.has(parent.id);
  return (
    <ul className="ch-kids">
      {shown.map((k) => (
        <Row key={k.id} n={k} ui={ui} all={all} />
      ))}
      {folded.length > 0 && (
        <>
          <li className="ch-kid" data-folded={parent.id}>
            <ListRow
              size="compact"
              className="ch-dimrow"
              lead={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
              label={open ? `收起已结束的 ${count} 个` : `已结束 ${count} 个`}
              onClick={() => ui.toggleOpen(parent.id)}
              peek={
                <PeekCard
                  title={`已结束 ${count} 个`}
                  facts={latest.map(
                    (x) =>
                      [
                        x.exec.name,
                        agoText(ui.now - (x.endedAt ?? ui.now)),
                      ] as const,
                  )}
                />
              }
            />
          </li>
          {open && folded.map((k) => <Row key={k.id} n={k} ui={ui} all />)}
        </>
      )}
    </ul>
  );
}

/** 子代理块标题右边的「现状 / 全部」切换；全部旁边的数字是子代理总数 */
export function SubToggle({
  forest,
  ui,
}: {
  forest: readonly SubNode[];
  ui: SubUi;
}) {
  return (
    <Segmented
      size="sm"
      aria-label="子代理视图"
      options={[
        { value: "now", label: "现状" },
        {
          value: "all",
          label: "全部",
          count: forest.reduce((a, n) => a + countOf(n), 0),
        },
      ]}
      value={ui.all ? "all" : "now"}
      onChange={(v) => ui.setAll(v === "all")}
    />
  );
}

// 子代理调用树：根是主代理，下面是它派发的子代理（最多 3 层）；结束够久的自动折叠。
export function SubTree({
  forest,
  rootLive,
  ui,
}: {
  forest: readonly SubNode[];
  rootLive: boolean;
  ui: SubUi;
}) {
  const root: SubNode = {
    id: "root",
    exec: {
      id: "root",
      parentId: "",
      depth: 0,
      source: "task",
      member: null,
      run: null,
      name: "主代理",
      role: "",
      model: null,
      state: rootLive ? "run" : "idle",
      outcome: null,
      result: null,
      ctx: { used: 0, win: null },
      tools: [],
      since: "",
      ended: null,
      task: "",
      log: [],
    },
    status: rootLive ? "live" : "idle",
    endedAt: null,
    kids: [...forest],
  };
  return (
    <ul className="ch-tree">
      <li className="ch-kid" data-subagent="root">
        <ListRow
          size="compact"
          lead={<StatusMark status={root.status} />}
          label="主代理"
        />
        <Kids parent={root} ui={ui} all={false} />
      </li>
    </ul>
  );
}
