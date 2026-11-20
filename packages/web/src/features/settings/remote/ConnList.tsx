import type { ConnectionView } from "../../../api/connections";
import { Dot, PeekCard } from "../../../ui";
import { RailList } from "../frame/RailList";
import { connMenu, type Ready } from "./actions";
import { addrOf, relTime, stateOf, visibleConnections } from "./model";
import { mountsOf } from "./store";

export interface ConnListProps {
  state: Ready;
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (c: ConnectionView) => void;
}

const AUTH_TEXT = { key: "私钥", password: "密码" } as const;

// 行里放不下的事实：怎么连、凭据、挂了多少、上次什么时候用过
function peekFacts(c: ConnectionView, state: Ready): [string, string][] {
  const m = mountsOf(state, c.id);
  return [
    [
      "跳板",
      c.chain.length > 0 ? c.chain.map((r) => r.label).join(" → ") : "直连",
    ],
    ["认证", c.auth.kind ? AUTH_TEXT[c.auth.kind] : "尚未保存凭据"],
    [
      "目录挂载",
      m.directories.length === 0
        ? "没有"
        : `${m.directories.length} 个目录 · ${m.sessions} 个会话`,
    ],
    [
      c.status === "active" ? "最近活动" : "上次激活",
      c.lastActiveAt ? relTime(c.lastActiveAt) : "从未激活",
    ],
  ];
}

// 左列表：已激活在前、待处理次之，不分组；行右侧是状态点，细节在悬停卡片里。
export function ConnList({
  state,
  selectedId,
  query,
  onQuery,
  onSelect,
  onAdd,
  onRemove,
}: ConnListProps) {
  const items = visibleConnections(state.conns, query).map((c) => {
    const st = stateOf(c);
    return {
      id: c.id,
      label: c.label,
      sub: addrOf(c),
      trail: <Dot tone={st.tone} motion={st.motion} label={st.label} />,
      peek: <PeekCard title={c.label} facts={peekFacts(c, state)} />,
      menu: connMenu(c, state, onRemove),
    };
  });
  return (
    <RailList
      title="连接"
      total={state.conns.length}
      query={query}
      onQuery={onQuery}
      searchLabel="筛选名称、主机或用户"
      sections={items.length > 0 ? [{ key: "all", items }] : []}
      sel={selectedId}
      onSel={onSelect}
      addLabel="新建连接"
      onAdd={onAdd}
      noneText={state.conns.length === 0 ? "还没有连接" : "没有匹配的连接"}
    />
  );
}
