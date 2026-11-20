import { useEffect, useState } from "react";
import type { ProviderView } from "../../../api/providers";
import {
  Button,
  ConfirmDialog,
  Dot,
  Empty,
  Loading,
  PeekCard,
} from "../../../ui";
import { FormColumn, Page, SplitPane } from "../frame/layout";
import { useLeaveGuard } from "../frame/leave";
import { notify } from "../frame/notify";
import { RailList } from "../frame/RailList";
import { AddProviderDialog } from "./AddProviderDialog";
import { testNotice, useProviders } from "./actions";
import { matchesProvider, peekFacts, railOf, statusInfo } from "./model";
import { NewProviderModal } from "./NewProviderModal";
import { ProviderDetail } from "./ProviderDetail";
import type { ProvidersStore } from "./store";

/**
 * 供应商与模型：左边只列已配置的，右边是选中那个的连接、模型、高级。
 * 内置供应商要先在「添加」里挑出来才出现在左边（有环境变量等现成凭据的自动在列）。
 * `store` 仅测试注入；正常使用不传。
 */
export function ProvidersPage({ store: injected }: { store?: ProvidersStore }) {
  const { store, state } = useProviders(injected);
  const guard = useLeaveGuard();
  const [selId, setSelId] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProviderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const list = state.phase === "ready" ? state.list : null;
  const rail = list ? railOf(list, picked) : [];
  const selected = rail.find((p) => p.id === selId) ?? rail[0] ?? null;
  // 看着的这个供应商退出登录、移除密钥后会变成「未配置」，也要留在左边，别从眼前消失
  useEffect(() => {
    if (selected && selId !== selected.id) setSelId(selected.id);
    if (selected && !picked.has(selected.id))
      setPicked((s) => new Set([...s, selected.id]));
  }, [selected, selId, picked]);

  if (state.phase === "loading") return <Loading>正在读取供应商…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取供应商失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );

  const inRail = new Set(rail.map((p) => p.id));

  const test = async (p: ProviderView) => {
    setTesting(p.id);
    const { problem, done } = testNotice(await store.test(p.id));
    setTesting(null);
    notify(problem, done);
  };
  const closeRemove = () => {
    setRemoving(null);
    setRemoveError(null);
  };
  const remove = async (p: ProviderView) => {
    setBusy(true);
    const r = await store.remove(p.id);
    setBusy(false);
    if (!r.ok) return setRemoveError(r.message);
    closeRemove();
    setPicked((s) => new Set([...s].filter((x) => x !== p.id)));
    notify(null, `已删除「${p.name}」`);
  };

  const items = rail
    .filter((p) => matchesProvider(p, query))
    .map((p) => {
      const st = statusInfo(p);
      return {
        id: p.id,
        label: p.name,
        sub: p.status === "off" ? st.label : `${p.models.length} 个模型`,
        trail: <Dot tone={st.tone} label={st.label} />,
        peek: <PeekCard title={p.name} facts={peekFacts(p)} />,
        menu: [
          {
            id: "test",
            label: "测试连接",
            // 选中的这个可能有没保存的修改：先问清楚再测，测的总是已保存的配置
            onSelect: () =>
              p.id === selected?.id ? guard(() => void test(p)) : void test(p),
          },
          {
            id: "remove",
            label: "删除",
            tone: "danger" as const,
            separatorBefore: true,
            onSelect: () => setRemoving(p),
          },
        ],
      };
    });

  return (
    <Page>
      <SplitPane
        rail={
          <RailList
            title="供应商"
            total={rail.length}
            query={query}
            onQuery={setQuery}
            searchLabel="筛选名称或协议"
            sections={items.length > 0 ? [{ key: "all", items }] : []}
            sel={selected?.id ?? null}
            onSel={(id) => guard(() => setSelId(id))}
            addLabel="添加供应商"
            onAdd={() => guard(() => setAdding(true))}
            noneText={rail.length === 0 ? "还没有供应商" : "没有匹配的供应商"}
          />
        }
      >
        {selected ? (
          <ProviderDetail
            key={selected.id}
            p={selected}
            store={store}
            testing={testing === selected.id}
            onTest={() => void test(selected)}
            onRemove={() => setRemoving(selected)}
          />
        ) : (
          <FormColumn>
            <Empty
              title="还没有可用的供应商"
              description="添加一个后，新对话里才有模型可选。内置的只需要登录或填密钥；本地部署或中转用「自定义端点」。"
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  添加供应商
                </Button>
              }
            />
          </FormColumn>
        )}
      </SplitPane>

      {adding && (
        <AddProviderDialog
          list={list ?? []}
          added={inRail}
          onClose={() => setAdding(false)}
          onPickBuiltin={(id) => {
            setPicked(new Set([...picked, id]));
            setSelId(id);
            setQuery("");
            setAdding(false);
          }}
          onPickCustom={() => {
            setAdding(false);
            setCreating(true);
          }}
        />
      )}
      <NewProviderModal
        open={creating}
        store={store}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setQuery("");
          setSelId(id);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`删除「${removing?.name ?? ""}」`}
        confirmLabel="删除"
        busy={busy}
        error={removeError}
        onConfirm={() => removing && void remove(removing)}
        onClose={closeRemove}
      >
        {removing?.custom
          ? "只删除元枢里的这条自定义配置。被 Agent 使用时无法删除。"
          : "会删掉元枢里为它保存的密钥、订阅登录、地址和你添加的模型，它从左侧列表消失。环境变量里的凭据不归元枢管，不受影响。"}
      </ConfirmDialog>
    </Page>
  );
}
