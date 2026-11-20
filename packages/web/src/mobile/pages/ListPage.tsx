import { useEffect, useMemo, useState } from "react";
import { loadToken } from "../../api/http";
import { createSessionWithConfig } from "../../api/sessionConfig";
import { patchLibrarySession, sessionAction } from "../../api/sessionLibrary";
import { useNow } from "../../features/chat/status/useNow";
import {
  useCurrentWorkspace,
  useLibraryState,
} from "../../features/workspace/library/LibraryProvider";
import { errorText } from "../../features/workspace/library/libraryStore";
import type { Sess } from "../../features/workspace/sidebar/model";
import {
  Dot,
  Empty,
  IconButton,
  ListRow,
  Loading,
  Sheet,
  toast,
} from "../../ui";
import {
  ArchiveIcon,
  PinIcon,
  PlusIcon,
  SlidersIcon,
  ToolsIcon,
} from "../../ui/icons";
import { useNav, useRoute } from "../nav/NavProvider";
import { TopBar } from "../ui/TopBar";
import { useLongPress } from "../ui/useLongPress";
import { buildListModel, type Need } from "./listModel";
import { ToolsSheet } from "./ToolsSheet";

/** 每个工作区先露出几个会话，其余折在「显示全部」里 */
const SHOWN = 5;

const Ago = ({ ago }: { ago: Sess["ago"] }) => (
  <>
    {ago[0] && <span className="t-mono">{ago[0]}</span>}
    {ago[1]}
  </>
);

// 状态点：执行中（绿、脉动）、待处理（琥珀）、出错（红）、有新结果（蓝）；待命不画，列表才不会满屏是点。
function StatusDot({ s }: { s: Sess }) {
  if (s.status === "running")
    return <Dot tone="live" motion="pulse" label="执行中" />;
  if (s.status === "blocked") return <Dot tone="warn" label="待处理" />;
  if (s.unread === "error") return <Dot tone="danger" label="出错" />;
  if (s.unread === "result") return <Dot tone="accent" label="有新结果" />;
  return null;
}

function SessionRow({
  s,
  sub,
  onOpen,
  onMenu,
}: {
  s: Sess;
  sub: React.ReactNode;
  onOpen: () => void;
  /** 长按：这一行的操作（置顶、归档） */
  onMenu: () => void;
}) {
  const press = useLongPress(onMenu);
  return (
    <ListRow
      className="m-row"
      label={s.title}
      sub={sub}
      trail={<StatusDot s={s} />}
      onClick={onOpen}
      {...press}
    />
  );
}

function NeedRows({
  needs,
  open,
  menu,
}: {
  needs: Need[];
  open: (id: string) => void;
  menu: (id: string) => void;
}) {
  if (needs.length === 0) return null;
  return (
    <section className="m-sec" aria-label="需要你">
      <h2 className="m-sec-h t-group">
        需要你<span className="t-mono">{needs.length}</span>
      </h2>
      {needs.map((n) => (
        <SessionRow
          key={n.session.id}
          s={n.session}
          sub={`${n.workspaceName} · ${n.reason === "blocked" ? "等你处理" : "出错了"}`}
          onOpen={() => open(n.session.id)}
          onMenu={() => menu(n.session.id)}
        />
      ))}
    </section>
  );
}

// 长按一行：置顶 / 取消置顶、归档（运行中的会话归档会被服务端拒绝，原因照实显示）
function RowSheet({ sid }: { sid: string }) {
  const nav = useNav();
  const session = useLibraryState((s) => s.sessions.find((x) => x.id === sid));
  const run = (act: () => Promise<unknown>) => {
    nav.back();
    act().catch((e) => toast(errorText(e), { tone: "danger" }));
  };
  if (!session) return null;
  return (
    <Sheet title={session.title} onClose={nav.back}>
      <ListRow
        className="m-row"
        lead={<PinIcon />}
        label={session.pinned ? "取消置顶" : "置顶"}
        onClick={() =>
          run(() =>
            patchLibrarySession(loadToken(), sid, { pinned: !session.pinned }),
          )
        }
      />
      <ListRow
        className="m-row"
        lead={<ArchiveIcon />}
        label="归档"
        onClick={() => run(() => sessionAction(loadToken(), sid, "archive"))}
      />
    </Sheet>
  );
}

export function ListPage() {
  const nav = useNav();
  const route = useRoute();
  const workspaces = useLibraryState((s) => s.workspaces);
  const groups = useLibraryState((s) => s.groups);
  const sessions = useLibraryState((s) => s.sessions);
  const ready = useLibraryState((s) => s.ready);
  const now = useNow(true);
  const [all, setAll] = useState<ReadonlySet<string>>(new Set());
  const current = useCurrentWorkspace();

  const model = useMemo(
    () => buildListModel(workspaces, groups, sessions, now, (id) => id),
    [workspaces, groups, sessions, now],
  );
  const open = (sid: string) => nav.push({ name: "chat", sid });
  const menu = (sid: string) =>
    nav.push({ name: "list", layer: "row", target: sid });
  // 工作区的工具：标签页都挂在一条会话下（锚点），取这个工作区最近的一条
  const openTools = (workspaceId: string) => {
    const anchor = sessions.find(
      (x) => x.workspaceId === workspaceId && x.lifecycle !== "archived",
    );
    if (!anchor)
      return toast("这个工作区还没有会话，先新建一个", { tone: "warn" });
    nav.push({ name: "list", layer: "tools", target: workspaceId });
  };
  const toolsWorkspace =
    route.name === "list" && route.layer === "tools" ? route.target : undefined;
  // 工具抽屉要读这个工作区的目录清单：当前工作区跟着它走（直接打开带 target 的地址也一样）
  // biome-ignore lint/correctness/useExhaustiveDependencies: current 每次渲染都是新对象，只在 target 变化时同步
  useEffect(() => {
    if (toolsWorkspace) current.select(toolsWorkspace);
  }, [toolsWorkspace]);
  const toolsAnchor = toolsWorkspace
    ? sessions.find(
        (x) => x.workspaceId === toolsWorkspace && x.lifecycle !== "archived",
      )
    : undefined;

  const create = (workspaceId: string) => {
    createSessionWithConfig(loadToken(), { workspaceId }).then(
      ({ id }) => nav.replace({ name: "chat", sid: id }),
      (e) => toast(errorText(e), { tone: "danger" }),
    );
  };
  const live = workspaces.filter((w) => !w.archived);
  const onNew = () => {
    if (live.length === 0)
      return toast("还没有工作区，先在电脑上创建一个", { tone: "warn" });
    const [only] = live;
    if (live.length === 1 && only) {
      createSessionWithConfig(loadToken(), { workspaceId: only.id }).then(
        ({ id }) => nav.push({ name: "chat", sid: id }),
        (e) => toast(errorText(e), { tone: "danger" }),
      );
    } else nav.push({ name: "list", layer: "new" });
  };

  return (
    <div className="m-page">
      <TopBar
        title="元枢"
        lead={<img src="/mark.svg" width={24} height={24} alt="" />}
        end={
          <>
            <IconButton label="新建会话" icon={<PlusIcon />} onClick={onNew} />
            <IconButton
              label="设置"
              icon={<SlidersIcon />}
              onClick={() => nav.push({ name: "settings" })}
            />
          </>
        }
      />
      <div className="m-scroll">
        {!ready ? (
          <Loading>读取会话…</Loading>
        ) : (
          <>
            <NeedRows needs={model.needs} open={open} menu={menu} />
            {model.sections.map((sec) => (
              <section key={sec.group?.id ?? "none"} className="m-sec">
                {sec.group && (
                  <h2 className="m-sec-h t-group">{sec.group.name}</h2>
                )}
                {sec.list.map((w) => {
                  const full = all.has(w.id);
                  const shown = full ? w.sessions : w.sessions.slice(0, SHOWN);
                  return (
                    <div key={w.id} className="m-ws">
                      <div className="m-ws-head">
                        <h3 className="m-ws-h t-entry">{w.name}</h3>
                        <IconButton
                          label={`${w.name} 的工具`}
                          icon={<ToolsIcon />}
                          onClick={() => openTools(w.id)}
                        />
                      </div>
                      {shown.map((s) => (
                        <SessionRow
                          key={s.id}
                          s={s}
                          sub={<Ago ago={s.ago} />}
                          onOpen={() => open(s.id)}
                          onMenu={() => menu(s.id)}
                        />
                      ))}
                      {w.sessions.length > SHOWN && !full && (
                        <ListRow
                          className="m-row"
                          label={`显示全部 ${w.sessions.length} 个`}
                          onClick={() => setAll((a) => new Set(a).add(w.id))}
                        />
                      )}
                      {w.sessions.length === 0 && (
                        <p className="m-ws-none t-aux">还没有会话</p>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            {model.sections.length === 0 && (
              <Empty
                title="还没有工作区"
                description="工作区要在电脑上创建，创建后会出现在这里。"
              />
            )}
          </>
        )}
      </div>
      {route.name === "list" && route.layer === "row" && route.target && (
        <RowSheet sid={route.target} />
      )}
      {toolsAnchor && <ToolsSheet sid={toolsAnchor.id} />}
      {route.name === "list" && route.layer === "new" && (
        <Sheet title="在哪个工作区新建" onClose={nav.back}>
          {live.map((w) => (
            <ListRow
              key={w.id}
              className="m-row"
              label={w.name}
              onClick={() => create(w.id)}
            />
          ))}
        </Sheet>
      )}
    </div>
  );
}
