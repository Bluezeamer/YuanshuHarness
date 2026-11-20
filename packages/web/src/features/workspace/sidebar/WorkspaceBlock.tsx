import type { CSSProperties } from "react";
import { Dot, IconButton, ListRow, Menu, PeekCard } from "../../../ui";
import {
  ChevronRightIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SlidersIcon,
} from "../../../ui/icons";
import type { SidebarController } from "./controller";
import { menuAt } from "./menuAt";
import { workspaceItems } from "./menus";
import { type Agg, shortPath, type Ws, workspaceFacts } from "./model";
import { SessionRows } from "./SessionRows";
import { overBefore, wsDropProps } from "./wsDrop";

// 折叠时也亮：最紧急的状态点带计数，再加一枚未读标记；什么都没有就只给会话数。
export function Pulse({ agg }: { agg: Agg }) {
  const quiet = agg.blocked + agg.running === 0;
  return (
    <span className="rl-agg">
      {agg.blocked > 0 && (
        <span className="rl-n">
          <Dot size="sm" tone="warn" />
          <span className="t-mono">{agg.blocked}</span>
        </span>
      )}
      {agg.running > 0 && (
        <span className="rl-n">
          <Dot size="sm" tone="live" motion="pulse" />
          <span className="t-mono">{agg.running}</span>
        </span>
      )}
      {quiet && <span className="t-mono rl-total">{agg.total}</span>}
      {agg.unread && (
        <Dot
          size="sm"
          tone={agg.unread === "error" ? "danger" : "accent"}
          label={agg.unread === "error" ? "有出错" : "有新结果"}
        />
      )}
    </span>
  );
}

export function WorkspaceBlock({
  ws,
  index,
  c,
  archived = false,
}: {
  ws: Ws;
  index: number;
  c: SidebarController;
  /** 在「已归档工作区」栏里：菜单给「恢复」，不给「新对话」 */
  archived?: boolean;
}) {
  const searching = c.query.trim() !== "";
  const open = searching || c.open.has(ws.id);
  const shown = c.shown(ws);
  const agg = c.aggOf(ws);
  const liveRows = shown.filter((s) => !s.archived);
  const archivedRows = shown.filter((s) => s.archived);
  const archivedOpen = searching || c.archivedOpen.has(ws.id);
  return (
    <>
      {overBefore(c, ws.id) && (
        <div className="rl-dropline" aria-hidden="true" />
      )}
      <section
        className="rl-ws"
        style={{ "--i": index } as CSSProperties}
        data-current={c.currentWorkspace === ws.id || undefined}
        data-open={open || undefined}
        data-dragging={c.drag?.workspace === ws.id || undefined}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 工作区头只作拖放的把手与落点，点击与键盘交互在内部按钮上 */}
        <div
          className="rl-wh"
          draggable={!archived}
          onDragStart={(e) => c.dragWorkspace(e, ws.id)}
          onDragEnd={c.dragEnd}
          {...(archived ? {} : wsDropProps(c, { before: ws.id }))}
          data-selected={
            (c.selection?.kind === "workspace" &&
              c.selection.ids.includes(ws.id)) ||
            undefined
          }
        >
          <IconButton
            className="rl-chev"
            size="sm"
            label={open ? "收起" : "展开"}
            aria-expanded={open}
            icon={<ChevronRightIcon className="rl-chev-i" />}
            onClick={() => c.toggleOpen(ws.id)}
          />
          <ListRow
            className="rl-wrow"
            label={
              <span className="rl-wline">
                <span className="rl-wtitle">
                  <span className="rl-wname">{ws.name}</span>
                  {ws.pinned && <PinIcon className="rl-pinned" size={12} />}
                </span>
                <Pulse agg={agg} />
              </span>
            }
            sub={
              <span className="t-mono">
                {shortPath(ws.path)}
                {ws.extraDirs ? ` +${ws.extraDirs}` : ""}
              </span>
            }
            peek={
              <PeekCard
                title={ws.name}
                {...(ws.description ? { text: ws.description } : {})}
                facts={workspaceFacts(ws, agg)}
              />
            }
            onClick={(e) => c.pickWorkspace(ws.id, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              c.setMenu(menuAt("workspace", ws.id, e));
            }}
            actions={
              <Menu
                label="工作区菜单"
                items={workspaceItems(ws, c, archived)}
                trigger={(p) => (
                  <IconButton
                    size="sm"
                    label="工作区菜单"
                    icon={<MoreIcon />}
                    {...p}
                  />
                )}
              />
            }
          />
        </div>
        {open && (
          <div className="rl-wb">
            {shown.length === 0 && (
              <div className="rl-none t-aux">还没有对话</div>
            )}
            <SessionRows list={liveRows} c={c} />
            {archivedRows.length > 0 && (
              <>
                <ListRow
                  className="rl-fold"
                  size="compact"
                  data-open={archivedOpen || undefined}
                  label={`已归档 ${archivedRows.length}`}
                  lead={<ChevronRightIcon className="rl-fchev" />}
                  onClick={() => c.toggleArchived(ws.id)}
                />
                {archivedOpen && <SessionRows list={archivedRows} c={c} />}
              </>
            )}
            {!archived && (
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
            )}
          </div>
        )}
      </section>
    </>
  );
}
