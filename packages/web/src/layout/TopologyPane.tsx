import { useEffect, useState } from "react";
import { getTopology, loadToken, type TopologyNode } from "../api";
import { Link } from "../router";

const NODE_W = 180;
const NODE_H = 60;
const NODE_GAP_Y = 24;
const INDENT = 40;

const STATE_COLOR: Record<TopologyNode["state"], string> = {
  running: "var(--ok)",
  idle: "var(--mute)",
  done: "var(--ok)",
  failed: "var(--danger)",
  interrupted: "var(--warn)",
};

interface Layout {
  id: string;
  x: number;
  y: number;
  depth: number;
}

// 简单树布局：深度优先遍历，每层向右缩进，节点垂直堆叠。
function layout(nodes: TopologyNode[]): Layout[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const sibs = children.get(n.parentId) ?? [];
      sibs.push(n.id);
      children.set(n.parentId, sibs);
    } else {
      roots.push(n.id);
    }
  }
  const out: Layout[] = [];
  let row = 0;
  const visit = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return;
    out.push({ id, x: depth * INDENT, y: row * (NODE_H + NODE_GAP_Y), depth });
    row++;
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return out;
}

const POLL_MS = 3000;

// 本色只做描边；文字用 -ink，满足对比度（见 yuanshu-webui-style）。
const STATE_INK: Record<TopologyNode["state"], string> = {
  running: "var(--ok-ink)",
  idle: "var(--mute)",
  done: "var(--ok-ink)",
  failed: "var(--danger)",
  interrupted: "var(--warn-ink)",
};

const STATE_LABEL: Record<TopologyNode["state"], string> = {
  running: "运行中",
  idle: "空闲",
  done: "完成",
  failed: "失败",
  interrupted: "被中断",
};

// 拓扑是全局的（不随绑定会话变化）；子会话状态没有推送，轮询刷新。
export function TopologyPane() {
  const [nodes, setNodes] = useState<TopologyNode[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const r = await getTopology(loadToken());
      if (!live) return;
      setFailed(!r.ok);
      if (r.ok) setNodes(r.data);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (nodes === null || nodes.length === 0) {
    return (
      <p role="status" className="m-0 p-4 text-mute">
        {nodes === null
          ? failed
            ? "拓扑加载失败，稍后自动重试"
            : "加载中…"
          : "暂无协作会话：会话派发子代理后会出现在这里"}
      </p>
    );
  }

  const ls = layout(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byLayout = new Map(ls.map((l) => [l.id, l]));
  const maxX = Math.max(...ls.map((l) => l.x));
  const maxY = Math.max(...ls.map((l) => l.y));
  const viewW = maxX + NODE_W + 32;
  const viewH = maxY + NODE_H + 32;

  return (
    <div className="h-full overflow-auto p-4">
      {failed && (
        <p role="status" className="m-0 mb-2 text-xs text-danger">
          刷新失败，显示的是上一次的结果
        </p>
      )}
      <svg
        aria-label="协作拓扑"
        width={viewW}
        height={viewH}
        viewBox={`0 0 ${viewW} ${viewH}`}
      >
        {ls.map((l) => {
          const n = byId.get(l.id);
          if (!n?.parentId) return null;
          const parent = byLayout.get(n.parentId);
          if (!parent) return null;
          const x1 = parent.x + NODE_W / 2;
          const y1 = parent.y + NODE_H;
          const x2 = l.x + NODE_W / 2;
          const y2 = l.y;
          const my = (y1 + y2) / 2;
          return (
            <path
              key={`e-${l.id}`}
              d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
              fill="none"
              stroke="var(--line)"
              strokeWidth={1.5}
            />
          );
        })}
        {ls.map((l) => {
          const n = byId.get(l.id);
          if (!n) return null;
          const color = STATE_COLOR[n.state];
          const name = n.name || n.id.slice(0, 8);
          return (
            <Link
              key={l.id}
              to={`/sessions/${encodeURIComponent(n.id)}`}
              aria-label={`${name}，${STATE_LABEL[n.state]}${n.denied > 0 ? `，被拒 ${n.denied} 次` : ""}，打开会话详情`}
              className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-accent"
            >
              <title>
                {[
                  n.task ?? name,
                  ...n.deniedReasons.map((r) => `被拒：${r}`),
                ].join("\n")}
              </title>
              <rect
                x={l.x}
                y={l.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill="var(--panel)"
                stroke={color}
                strokeWidth={2}
              />
              <text
                x={l.x + NODE_W / 2}
                y={l.y + 18}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill="var(--ink)"
              >
                {name.length > 20 ? `${name.slice(0, 20)}…` : name}
              </text>
              <text
                x={l.x + NODE_W / 2}
                y={l.y + 36}
                textAnchor="middle"
                fontSize={11}
                fill={STATE_INK[n.state]}
              >
                {STATE_LABEL[n.state]}
              </text>
              {n.denied > 0 && (
                <text
                  x={l.x + NODE_W / 2}
                  y={l.y + 52}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--danger)"
                >
                  拒绝 {n.denied} 次
                </text>
              )}
            </Link>
          );
        })}
      </svg>
    </div>
  );
}
