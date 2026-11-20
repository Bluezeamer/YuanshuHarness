import { useEffect, useState } from "react";
import { Button, Dot, Empty, Loading, PeekCard } from "../../../../ui";
import { PlusIcon } from "../../../../ui/icons";
import { FormColumn, SplitPane } from "../../frame/layout";
import { useLeaveGuard } from "../../frame/leave";
import { notify } from "../../frame/notify";
import { RailList } from "../../frame/RailList";
import { useSnapshot } from "../common/hooks";
import { toggleEnabled } from "./actions";
import {
  contentText,
  KIND_TEXT,
  kindOf,
  matchesPlugin,
  nameOf,
  statusOf,
  versionText,
} from "./model";
import { PluginDetail } from "./PluginDetail";
import { PluginInstallModal } from "./PluginInstallModal";
import { PluginRemoveDialog } from "./PluginRemoveDialog";
import type { PluginStore } from "./store";

type Dialog = { kind: "install" } | { kind: "remove"; source: string };

// pi 扩展页签：左列表 + 右详情，与 MCP 页签同一个版式。
// 登记在 pi 自己的 settings.json 里，所以行没有 id，用来源原文当键。
export function PluginTab({ store }: { store: PluginStore }) {
  const state = useSnapshot(store);
  const guard = useLeaveGuard();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    void store.load();
  }, [store]);

  if (state.phase === "loading") return <Loading>正在读取 pi 扩展…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取 pi 扩展失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );

  const { plugins, busy } = state;
  const selected = plugins.find((p) => p.source === sel) ?? plugins[0] ?? null;
  // 把隐含的默认选中固化下来：列表重排时详情不会跳到别的包
  if (selected && selected.source !== sel) setSel(selected.source);
  const close = () => setDialog(null);
  const target =
    dialog?.kind === "remove"
      ? plugins.find((p) => p.source === dialog.source)
      : undefined;

  const items = plugins
    .filter((p) => matchesPlugin(p, query))
    .map((p) => {
      const st = statusOf(p, busy[p.source] ?? null);
      return {
        id: p.source,
        label: nameOf(p.source),
        sub: `${KIND_TEXT[kindOf(p.source)]} · ${versionText(p)}`,
        trail: <Dot tone={st.tone ?? "idle"} label={st.text} />,
        peek: (
          <PeekCard
            title={nameOf(p.source)}
            text={contentText(p)}
            facts={[
              ["来源", p.source],
              ["版本", versionText(p)],
              ["扩展", `${p.extensionCount} 个`],
              ["技能", `${p.skillCount} 个`],
              ["状态", st.text],
            ]}
          />
        ),
        menu: [
          ...(p.installed
            ? [
                {
                  id: "toggle",
                  label: p.enabled ? "停用" : "启用",
                  onSelect: () => void toggleEnabled(store, p),
                },
              ]
            : []),
          {
            id: "remove",
            label: "卸载",
            tone: "danger" as const,
            separatorBefore: p.installed,
            onSelect: () => setDialog({ kind: "remove", source: p.source }),
          },
        ],
      };
    });

  return (
    <>
      <SplitPane
        rail={
          <RailList
            title="pi 扩展"
            total={plugins.length}
            query={query}
            onQuery={setQuery}
            searchLabel="筛选来源"
            sections={items.length > 0 ? [{ key: "all", items }] : []}
            sel={selected?.source ?? null}
            onSel={(source) => guard(() => setSel(source))}
            addLabel="安装扩展"
            onAdd={() => setDialog({ kind: "install" })}
            noneText={
              plugins.length === 0 ? "还没有安装 pi 扩展" : "没有匹配的扩展"
            }
          />
        }
      >
        {selected ? (
          <PluginDetail
            key={selected.source}
            plugin={selected}
            store={store}
            state={state}
            onRemove={() =>
              setDialog({ kind: "remove", source: selected.source })
            }
          />
        ) : (
          <FormColumn>
            <Empty
              title="还没有安装 pi 扩展"
              description="pi 扩展是 pi 生态里的包（npm 包或 git 仓库），装好后它注册的工具会出现在新会话里。扩展是可执行的代码，只装你信任的来源。"
              action={
                <Button
                  variant="primary"
                  icon={<PlusIcon size={12} />}
                  onClick={() => setDialog({ kind: "install" })}
                >
                  安装扩展
                </Button>
              }
            />
          </FormColumn>
        )}
      </SplitPane>
      {dialog?.kind === "install" && (
        <PluginInstallModal
          store={store}
          onClose={close}
          onInstalled={(source, name) => {
            close();
            setQuery("");
            if (source !== null) setSel(source);
            notify(null, `${name} 已安装，新会话或重载后生效`);
          }}
        />
      )}
      {dialog?.kind === "remove" && target && (
        <PluginRemoveDialog
          plugin={target}
          store={store}
          onClose={close}
          onDone={(name) => {
            close();
            notify(null, `${name} 已卸载`);
          }}
        />
      )}
    </>
  );
}
