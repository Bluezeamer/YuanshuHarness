import type { CSSProperties } from "react";
import { Dot, IconButton, ListRow, Menu, PeekCard } from "../../../ui";
import { ArchiveIcon, MoreIcon, PinIcon, RefreshIcon } from "../../../ui/icons";
import type { SidebarController } from "./controller";
import { menuAt } from "./menuAt";
import { sessionItems } from "./menus";
import { peekFacts, type Sess, treeOf } from "./model";

function Ago({ ago }: { ago: Sess["ago"] }) {
  return (
    <>
      {ago[0] && <span className="t-mono">{ago[0]}</span>}
      {ago[1]}
    </>
  );
}

// 状态点只给「值得看一眼」的两种；待命不画点，列表才不会满屏是点。
function Lead({ status }: { status: Sess["status"] }) {
  return (
    <span className="rl-lead">
      {status === "running" && (
        <Dot tone="live" motion="pulse" label="执行中" />
      )}
      {status === "blocked" && <Dot tone="warn" label="待处理" />}
    </span>
  );
}

// fork 默认叫「父名 · 分支N」：缩进已经说明从属，标题以父名开头时只显示后半，免得被截断后分不出谁是谁。
const forkLabel = (s: Sess, parent: string) =>
  s.title.startsWith(`${parent} · `)
    ? s.title.slice(parent.length + 3)
    : s.title;

function Row({
  s,
  c,
  parent,
  i,
}: {
  s: Sess;
  c: SidebarController;
  /** fork 的父会话标题；顶层会话不给 */
  parent?: string;
  i: number;
}) {
  const label = parent === undefined ? s.title : forkLabel(s, parent);
  return (
    <ListRow
      className="rl-row"
      style={{ "--i": i } as CSSProperties}
      size="compact"
      label={label}
      sub={parent === undefined ? undefined : "↳ 从某一轮分出"}
      lead={<Lead status={s.status} />}
      trail={
        <span className="rl-trail">
          {s.pinned && <PinIcon className="rl-pinned" size={12} />}
          {s.unread && (
            <Dot
              tone={s.unread === "error" ? "danger" : "accent"}
              label={s.unread === "error" ? "出错" : "新结果"}
            />
          )}
          <Ago ago={s.ago} />
        </span>
      }
      peek={<PeekCard title={s.title} facts={peekFacts(s, parent)} />}
      current={c.currentSession === s.id}
      selected={
        c.selection?.kind === "session" && c.selection.ids.includes(s.id)
      }
      data-viewing={c.viewing.has(s.id) || undefined}
      data-dragging={c.drag?.session === s.id || undefined}
      data-archived={s.archived || undefined}
      onClick={(e) => c.pickSession(s.id, e)}
      onDoubleClick={() => c.pinSession(s.id)}
      draggable={!s.archived}
      onDragStart={(e) => c.dragSession(e, s.id)}
      onDragEnd={c.dragEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        c.setMenu(menuAt("session", s.id, e));
      }}
      actions={
        <>
          {!s.archived && (
            <>
              <IconButton
                label="刷新上下文"
                size="sm"
                icon={<RefreshIcon />}
                onClick={() => c.refreshContext(s.id)}
              />
              <IconButton
                label="归档"
                size="sm"
                icon={<ArchiveIcon />}
                onClick={() => c.archiveSessions([s.id])}
              />
            </>
          )}
          <Menu
            label="更多"
            items={sessionItems(s, c)}
            trigger={(p) => (
              <IconButton size="sm" label="更多" icon={<MoreIcon />} {...p} />
            )}
          />
        </>
      }
    />
  );
}

export function SessionRows({
  list,
  c,
}: {
  list: readonly Sess[];
  c: SidebarController;
}) {
  let i = 0;
  return (
    <>
      {treeOf(list).map(({ s, kids }) => (
        <div key={s.id} className="rl-tree">
          <Row s={s} c={c} i={i++} />
          {kids.length > 0 && (
            <div className="rl-fork">
              {kids.map((k) => (
                <Row key={k.id} s={k} c={c} parent={s.title} i={i++} />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
