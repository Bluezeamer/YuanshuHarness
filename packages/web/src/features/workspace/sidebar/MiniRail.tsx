import { Button, Dot, IconButton, ListRow } from "../../../ui";
import { ChevronRightIcon, PlusIcon, SlidersIcon } from "../../../ui/icons";
import type { SidebarController } from "./controller";
import { type Agg, initialOf, type Ws } from "./model";
import { SessionRows } from "./SessionRows";

// 收起到 62px：只剩工作区首字母和一个状态点，悬停（或键盘聚焦）浮出该工作区的会话列表。
function Mini({ ws, agg, c }: { ws: Ws; agg: Agg; c: SidebarController }) {
  const tone =
    agg.blocked > 0
      ? "warn"
      : agg.running > 0
        ? "live"
        : agg.unread === "error"
          ? "danger"
          : agg.unread === "result"
            ? "accent"
            : null;
  return (
    <div
      className="rl-mi"
      data-current={c.currentWorkspace === ws.id || undefined}
    >
      <IconButton
        className="rl-mi-btn"
        label={ws.name}
        icon={<span className="t-entry">{initialOf(ws.name)}</span>}
        onClick={(e) => c.pickWorkspace(ws.id, e)}
      />
      {tone && (
        <Dot
          className="rl-mi-dot"
          size="sm"
          tone={tone}
          motion={tone === "live" ? "pulse" : undefined}
        />
      )}
      <div className="rl-fly" data-pin={c.flyOpen === ws.id || undefined}>
        <div className="rl-fly-card">
          <div className="rl-fly-h">
            <span className="t-entry">{ws.name}</span>
            <span className="t-mono rl-fly-path">{ws.path}</span>
          </div>
          {ws.sessions.length === 0 ? (
            <div className="rl-none t-aux">还没有对话</div>
          ) : (
            <SessionRows list={ws.sessions.filter((s) => !s.archived)} c={c} />
          )}
          <ListRow
            className="rl-new"
            size="compact"
            label="新对话"
            lead={<PlusIcon />}
            onClick={() => c.newSession(ws.id)}
            actions={
              <IconButton
                size="sm"
                label="新对话（带配置）…"
                icon={<SlidersIcon />}
                onClick={() => c.newSessionWith(ws.id)}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

export function MiniRail({
  c,
  onExpand,
}: {
  c: SidebarController;
  onExpand(): void;
}) {
  return (
    <aside className="rl rl-mini" aria-label="工作区与会话（已收起）">
      <header className="rl-top">
        <IconButton
          label="展开左轨"
          icon={<ChevronRightIcon />}
          onClick={onExpand}
        />
      </header>
      <nav className="rl-mini-list" aria-label="工作区">
        {c.sections.map(({ group, list }) => (
          <div key={group?.id ?? "none"} className="rl-mini-group">
            {list.map((w) => (
              <Mini key={w.id} ws={w} agg={c.aggOf(w)} c={c} />
            ))}
          </div>
        ))}
      </nav>
      <footer className="rl-mini-foot">
        <IconButton
          label="新建工作区"
          icon={<PlusIcon />}
          onClick={c.newWorkspace}
        />
        <Button variant="ghost" size="sm" onClick={c.openSettings}>
          设置
        </Button>
      </footer>
    </aside>
  );
}
