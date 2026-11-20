import { useEffect, useState } from "react";
import { Button, Dot, Empty, Loading, PeekCard } from "../../../../ui";
import { PlusIcon } from "../../../../ui/icons";
import { FormColumn, SplitPane } from "../../frame/layout";
import { useLeaveGuard } from "../../frame/leave";
import { notify } from "../../frame/notify";
import { RailList } from "../../frame/RailList";
import { autoCheckUpdates } from "../common/autoCheck";
import { useSnapshot } from "../common/hooks";
import {
  check,
  checkAfter,
  checkAll,
  checkUpdates,
  toggleEnabled,
} from "./actions";
import { McpDetail } from "./McpDetail";
import { McpEditor } from "./McpEditor";
import { McpInfoModal } from "./McpInfoModal";
import { McpPinDialog } from "./McpPinDialog";
import { McpRemoveDialog } from "./McpRemoveDialog";
import { McpVersionsDialog } from "./McpVersionsDialog";
import {
  matchesServer,
  NO_DESCRIPTION,
  statusOf,
  toolCount,
  versionText,
} from "./model";
import type { McpStore } from "./store";

type Dialog =
  | { kind: "add" }
  | { kind: "edit" | "info" | "pin" | "versions" | "remove"; name: string };

// MCP 页签：左列表 + 右详情。「运行位置」与技能的「分发」是同一个版式。
export function McpTab({ store }: { store: McpStore }) {
  const state = useSnapshot(store);
  const guard = useLeaveGuard();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  useEffect(() => {
    void store
      .load()
      .then(() => autoCheckUpdates("mcp", () => store.checkUpdates()));
  }, [store]);

  if (state.phase === "loading") return <Loading>正在读取 MCP 服务…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取 MCP 服务失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );

  const { servers, busy } = state;
  const selected = servers.find((m) => m.name === sel) ?? servers[0] ?? null;
  // 把隐含的默认选中固化下来：列表重排时详情不会跳到别的服务
  if (selected && selected.name !== sel) setSel(selected.name);
  const close = () => setDialog(null);
  const target =
    dialog && "name" in dialog
      ? servers.find((m) => m.name === dialog.name)
      : undefined;

  const items = servers
    .filter((m) => matchesServer(m, query))
    .map((m) => {
      const st = statusOf(m, busy[m.name] ?? null);
      const total = toolCount(m);
      return {
        id: m.name,
        label: m.name,
        sub: `${m.global ? "全局 · " : ""}${m.transport} · ${versionText(m)}`,
        trail: <Dot tone={st.tone ?? "idle"} label={st.text} />,
        peek: (
          <PeekCard
            title={m.name}
            text={m.description === NO_DESCRIPTION ? undefined : m.description}
            facts={[
              ["范围", m.global ? "全局" : "按工作区勾选"],
              ["传输", m.transport],
              ["版本", versionText(m)],
              [
                "工具",
                total > 0
                  ? `${total} 个`
                  : m.enabled
                    ? "握手后才有"
                    : "已禁用，未连接",
              ],
              ["审批", m.approval === "allow" ? "放行" : "审批"],
              ["状态", st.text],
            ]}
          />
        ),
        menu: [
          {
            id: "check",
            label: "检测",
            disabled: !m.enabled,
            onSelect: (): void => {
              void check(store, m.name).then((p) => notify(p, "检测通过"));
            },
          },
          {
            id: "toggle",
            label: m.enabled ? "禁用" : "启用",
            onSelect: () => void toggleEnabled(store, m),
          },
          {
            id: "remove",
            label: "卸载",
            tone: "danger" as const,
            separatorBefore: true,
            onSelect: () => setDialog({ kind: "remove", name: m.name }),
          },
        ],
      };
    });

  return (
    <>
      <SplitPane
        rail={
          <RailList
            title="MCP 服务"
            total={servers.length}
            menu={[
              {
                id: "check-all",
                label: "检测全部",
                disabled: checkingAll || !servers.some((m) => m.enabled),
                onSelect: () => {
                  setCheckingAll(true);
                  void checkAll(store).finally(() => setCheckingAll(false));
                },
              },
              {
                id: "check-updates",
                label: "检查更新",
                disabled: checkingUpdates || !servers.some((m) => m.pinned),
                onSelect: () => {
                  setCheckingUpdates(true);
                  void checkUpdates(store).finally(() =>
                    setCheckingUpdates(false),
                  );
                },
              },
            ]}
            query={query}
            onQuery={setQuery}
            searchLabel="筛选名称、描述或目标"
            sections={items.length > 0 ? [{ key: "all", items }] : []}
            sel={selected?.name ?? null}
            onSel={(name) => guard(() => setSel(name))}
            addLabel="添加服务"
            onAdd={() => setDialog({ kind: "add" })}
            noneText={
              servers.length === 0 ? "还没有 MCP 服务" : "没有匹配的服务"
            }
          />
        }
      >
        {selected ? (
          <McpDetail
            key={selected.name}
            server={selected}
            store={store}
            state={state}
            onEdit={() => setDialog({ kind: "edit", name: selected.name })}
            onInfo={() => setDialog({ kind: "info", name: selected.name })}
            onPin={() => setDialog({ kind: "pin", name: selected.name })}
            onVersions={() =>
              setDialog({ kind: "versions", name: selected.name })
            }
            onRemove={() => setDialog({ kind: "remove", name: selected.name })}
          />
        ) : (
          <FormColumn>
            <Empty
              title="还没有 MCP 服务"
              description="MCP 服务给会话提供额外的工具。粘贴一段 mcpServers 配置就能添加：stdio 服务起在 Server 上，http 服务由 Server 直接连接。"
              action={
                <Button
                  variant="primary"
                  icon={<PlusIcon size={12} />}
                  onClick={() => setDialog({ kind: "add" })}
                >
                  添加服务
                </Button>
              }
            />
          </FormColumn>
        )}
      </SplitPane>
      {dialog?.kind === "add" && (
        <McpEditor
          store={store}
          onClose={close}
          onDone={(saved) => {
            close();
            setQuery("");
            setSel(saved.name);
            if (saved.enabled)
              return void checkAfter(store, saved.name, `${saved.name} 已添加`);
            notify(null, `${saved.name} 已添加，启用后可以检测或试装并固定`);
          }}
        />
      )}
      {dialog?.kind === "edit" && target && (
        <McpEditor
          store={store}
          editing={target}
          onClose={close}
          onDone={(saved) => {
            close();
            setSel(saved.name);
            if (saved.enabled)
              return void checkAfter(
                store,
                saved.name,
                `${saved.name} 的配置已保存`,
              );
            notify(null, `${saved.name} 的配置已保存`);
          }}
        />
      )}
      {dialog?.kind === "info" && target && (
        <McpInfoModal
          server={target}
          onClose={close}
          onEdit={() => setDialog({ kind: "edit", name: target.name })}
        />
      )}
      {dialog?.kind === "pin" && target && (
        <McpPinDialog
          server={target}
          store={store}
          onClose={close}
          onDone={(version) => {
            close();
            notify(null, `${target.name} 已固定在 ${version}`);
          }}
        />
      )}
      {dialog?.kind === "versions" && target && (
        <McpVersionsDialog server={target} store={store} onClose={close} />
      )}
      {dialog?.kind === "remove" && target && (
        <McpRemoveDialog
          servers={[target]}
          store={store}
          onClose={close}
          onDone={(removed, problems) => {
            close();
            notify(problems, `已卸载 ${removed.join("、")}`);
          }}
        />
      )}
    </>
  );
}
