import {
  Button,
  Dot,
  Empty,
  IconButton,
  ListRow,
  Menu,
  SearchBox,
} from "../../../ui";
import {
  BackIcon,
  ChevronRightIcon,
  MoreIcon,
  PlusIcon,
} from "../../../ui/icons";
import { ARCHIVED_WORKSPACES, type SidebarController } from "./controller";
import { ConfirmLayer } from "./dialogs";
import { GroupDialog } from "./GroupDialog";
import { MiniRail } from "./MiniRail";
import { groupItems, sessionItems, workspaceItems } from "./menus";
import { type Agg, type Group, mergeAgg } from "./model";
import { NameDialog } from "./NameDialog";
import { Pulse, WorkspaceBlock } from "./WorkspaceBlock";
import { overGroup, wsDropProps } from "./wsDrop";
import "./sidebar.css";

function GroupHead({
  group,
  open,
  agg,
  drop,
  items,
  onToggle,
  ...rest
}: {
  group: Group;
  open: boolean;
  agg: Agg;
  drop: boolean;
  items: ReturnType<typeof groupItems>;
  onToggle(): void;
} & ReturnType<typeof wsDropProps>) {
  return (
    <ListRow
      className="rl-ghead"
      size="compact"
      data-open={open || undefined}
      data-drop={drop || undefined}
      label={<span className="t-group">{group.name}</span>}
      lead={<Dot className="rl-tone" data-hue={group.tone} />}
      trail={
        <span className="rl-agg">
          {open ? (
            <span className="t-mono rl-total">{agg.total}</span>
          ) : (
            <Pulse agg={agg} />
          )}
          <ChevronRightIcon className="rl-gchev" />
        </span>
      }
      onClick={onToggle}
      actions={
        <Menu
          label={`${group.name} 的更多操作`}
          items={items}
          trigger={(p) => (
            <IconButton size="sm" label="分组操作" icon={<MoreIcon />} {...p} />
          )}
        />
      }
      {...rest}
    />
  );
}

// 「未分组」标签；拖着工作区时它是个落点：放进去就移出分组
function Ungrouped({ c }: { c: SidebarController }) {
  return (
    <div
      className="rl-ungrouped t-group"
      data-drop={overGroup(c, null) || undefined}
      {...wsDropProps(c, { group: null })}
    >
      未分组
    </div>
  );
}

// 左轨：工作区 → 会话。所有数据与动作都来自控制器，所以样张和真界面共用这一份。
export function Sidebar({
  c,
  collapsed,
  onCollapsedChange,
}: {
  c: SidebarController;
  /** 收起成 62px 的图标列 */
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
}) {
  if (collapsed)
    return <MiniRail c={c} onExpand={() => onCollapsedChange(false)} />;

  const sessionOf = (id: string) =>
    c.workspaces.flatMap((w) => w.sessions).find((s) => s.id === id);
  const menuItems = (() => {
    if (!c.menu) return [];
    if (c.menu.kind === "session") {
      const s = sessionOf(c.menu.id);
      return s ? sessionItems(s, c) : [];
    }
    const id = c.menu.id;
    const live = c.workspaces.find((w) => w.id === id);
    const archived = c.archivedWorkspaces.find((w) => w.id === id);
    const w = live ?? archived;
    return w ? workspaceItems(w, c, archived !== undefined) : [];
  })();

  const grouped = c.sections.some((s) => s.group);
  const searching = c.query.trim() !== "";
  const liveCount = c.workspaces.reduce(
    (k, w) => k + w.sessions.filter((x) => !x.archived).length,
    0,
  );
  const archivedOpen = searching || c.archivedOpen.has(ARCHIVED_WORKSPACES);
  const dragging = c.drag?.workspace !== undefined;
  let n = 0;

  return (
    <aside className="rl" aria-label="工作区与会话">
      <header className="rl-top">
        <span className="rl-brand">
          <img src="/mark.svg" width={28} height={28} alt="" />
          <span className="t-block">元枢</span>
        </span>
        <span className="rl-top-act">
          <IconButton
            label="新建工作区"
            icon={<PlusIcon />}
            onClick={c.newWorkspace}
          />
          <IconButton
            label="收起左轨"
            icon={<BackIcon />}
            onClick={() => onCollapsedChange(true)}
          />
        </span>
      </header>
      <div className="rl-search">
        <SearchBox
          aria-label="搜索会话与工作区"
          placeholder="搜索会话与工作区"
          value={c.query}
          onChange={c.setQuery}
        />
      </div>

      <nav className="rl-list" aria-label="工作区">
        {!c.loading &&
          c.workspaces.length === 0 &&
          c.archivedWorkspaces.length === 0 && (
            <Empty
              className="rl-empty"
              title="还没有工作区"
              description="工作区把一个项目目录和它的会话、终端、布局放在一起。"
              action={
                <Button variant="primary" onClick={c.newWorkspace}>
                  新建工作区
                </Button>
              }
            />
          )}
        {!c.loading && c.workspaces.length > 0 && c.sections.length === 0 && (
          <Empty
            compact
            className="rl-empty"
            title="没有匹配的结果"
            description={`没有会话或工作区包含「${c.query.trim()}」。`}
          />
        )}
        {c.sections.map(({ group, list }) => {
          const gid = group?.id ?? "none";
          const groupOpen = searching || !c.groupClosed.has(gid);
          return (
            <section key={gid} className="rl-group">
              {group ? (
                <GroupHead
                  group={group}
                  open={groupOpen}
                  agg={mergeAgg(list.map(c.aggOf))}
                  drop={overGroup(c, group.id)}
                  items={groupItems(group, c)}
                  onToggle={() => c.toggleGroup(gid)}
                  {...wsDropProps(c, { group: group.id })}
                />
              ) : (
                grouped && <Ungrouped c={c} />
              )}
              {groupOpen &&
                list.map((w) => (
                  <WorkspaceBlock key={w.id} ws={w} index={n++} c={c} />
                ))}
              {/* 组尾的落点：放在最后一个工作区之后 = 排到该组最后 */}
              {dragging && groupOpen && (
                <div
                  className="rl-dropend"
                  {...wsDropProps(c, { group: group?.id ?? null })}
                >
                  {overGroup(c, group?.id ?? null) && (
                    <div className="rl-dropline" aria-hidden="true" />
                  )}
                </div>
              )}
            </section>
          );
        })}
        {/* 工作区全在组里时没有「未分组」分区；拖着工作区时补一个空落点，否则拖不出组 */}
        {dragging && grouped && !c.sections.some((x) => !x.group) && (
          <Ungrouped c={c} />
        )}
        {c.archivedWorkspaces.length > 0 && (
          <section className="rl-group">
            <ListRow
              className="rl-fold"
              size="compact"
              data-open={archivedOpen || undefined}
              label={`已归档工作区 ${c.archivedWorkspaces.length}`}
              lead={<ChevronRightIcon className="rl-fchev" />}
              onClick={() => c.toggleArchived(ARCHIVED_WORKSPACES)}
            />
            {archivedOpen &&
              c.archivedWorkspaces.map((w) => (
                <WorkspaceBlock key={w.id} ws={w} index={n++} c={c} archived />
              ))}
          </section>
        )}
      </nav>

      <footer className="rl-foot">
        <div className="rl-foot-idle">
          <Button variant="ghost" size="sm" onClick={c.openSettings}>
            设置
          </Button>
          <Button variant="ghost" size="sm" onClick={c.openOverview}>
            总览
            <span className="t-mono"> {liveCount}</span>
          </Button>
          <span className="rl-host t-aux">本机</span>
        </div>
      </footer>

      {c.menu && menuItems.length > 0 && (
        <Menu
          label="菜单"
          open
          point={{ x: c.menu.x, y: c.menu.y }}
          onOpenChange={(o) => !o && c.setMenu(null)}
          trigger={() => null}
          items={menuItems}
        />
      )}
      <NameDialog spec={c.nameDialog} onClose={c.closeNameDialog} />
      <GroupDialog spec={c.groupDialog} onClose={c.closeGroupDialog} />
      <ConfirmLayer
        confirm={c.confirm}
        error={c.confirmError}
        busy={c.confirmBusy}
        onConfirm={c.doConfirm}
        onClose={c.closeConfirm}
      />
    </aside>
  );
}
