import { useState } from "react";
import type { VariableView } from "../../../api/variables";
import {
  Button,
  ConfirmDialog,
  copyText,
  Empty,
  Loading,
  PeekCard,
  TabPanel,
  toast,
} from "../../../ui";
import { FormColumn, ListColumn, Page, SplitPane } from "../frame/layout";
import { useLeaveGuard } from "../frame/leave";
import { PageTabs } from "../frame/PageTabs";
import { RailList, type RailSection } from "../frame/RailList";
import { AddVariableDialog } from "./AddVariableDialog";
import { useVariables } from "./actions";
import { groupNames, peekFacts, railTrail, sectionsOf } from "./model";
import { ReferencesPane } from "./ReferencesPane";
import { RenameGroupDialog } from "./RenameGroupDialog";
import { RotateModal } from "./RotateModal";
import type { VariablesStore } from "./store";
import { VariableDetail } from "./VariableDetail";

type View = "vars" | "refs";

/** 隐私变量。`store` 仅测试注入；正常使用不传。 */
export function VariablesPage({ store: injected }: { store?: VariablesStore }) {
  const { store, state } = useVariables(injected);
  const guard = useLeaveGuard();
  const [view, setView] = useState<View>("vars");
  const [sel, setSel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<VariableView | null>(null);
  const [removing, setRemoving] = useState<VariableView | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dissolving, setDissolving] = useState<string | null>(null);
  const [refName, setRefName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  if (state.phase === "loading") return <Loading>正在读取隐私变量…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取隐私变量失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );

  const { variables, workspaces, hosts } = state;
  const now = Date.now();
  const shown = sectionsOf(variables, query);
  const current =
    variables.find((v) => v.id === sel) ?? shown[0]?.items[0] ?? variables[0];
  const groups = groupNames(variables);

  const closeConfirm = () => {
    setRemoving(null);
    setDissolving(null);
    setConfirmError(null);
  };
  const confirm = async (
    act: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
  ) => {
    setBusy(true);
    const r = await act();
    setBusy(false);
    if (r.ok) {
      toast(done, { tone: "ok" });
      closeConfirm();
    } else setConfirmError(r.message);
  };

  const sections: RailSection[] = shown.map((s) => ({
    key: s.key,
    name: s.name,
    ...(s.isGroup
      ? {
          menu: [
            {
              id: "rename",
              label: "重命名变量组",
              onSelect: () => setRenaming(s.key),
            },
            {
              id: "dissolve",
              label: "解散变量组",
              tone: "danger" as const,
              separatorBefore: true,
              onSelect: () => setDissolving(s.key),
            },
          ],
        }
      : {}),
    items: s.items.map((v) => ({
      id: v.id,
      label: v.name,
      sub: v.desc,
      ...(railTrail(v) ? { trail: railTrail(v) } : {}),
      peek: (
        <PeekCard
          title={v.name}
          text={v.desc}
          facts={peekFacts(v, workspaces, now)}
        />
      ),
      menu: [
        {
          id: "copy",
          label: "复制引用写法",
          onSelect: () =>
            void copyText(`{{@${v.name}}}`).then((ok) =>
              toast(ok ? "已复制引用写法" : "浏览器不允许写入剪贴板", {
                tone: ok ? "ok" : "danger",
              }),
            ),
        },
        {
          id: "remove",
          label: "删除变量",
          tone: "danger" as const,
          separatorBefore: true,
          onSelect: () => setRemoving(v),
        },
      ],
    })),
  }));

  return (
    <Page>
      <PageTabs
        idBase="vr"
        aria-label="隐私变量视图"
        value={view}
        onChange={(v) => guard(() => setView(v as View))}
        tabs={[
          { id: "vars", label: "变量" },
          { id: "refs", label: "引用记录" },
        ]}
      />
      <TabPanel idBase="vr" id="vars" value={view} className="st-pane">
        <SplitPane
          rail={
            <RailList
              title="变量"
              total={variables.length}
              query={query}
              onQuery={setQuery}
              searchLabel="筛选名称或描述"
              sections={sections}
              sel={current?.id ?? null}
              onSel={(id) => guard(() => setSel(id))}
              addLabel="添加变量"
              onAdd={() => setAdding(true)}
              noneText={
                variables.length === 0 ? "还没有变量" : "没有匹配的变量"
              }
            />
          }
        >
          {current ? (
            <VariableDetail
              key={current.id}
              v={current}
              all={variables}
              workspaces={workspaces}
              store={store}
              now={now}
              onRotate={() => setRotating(current)}
              onRemove={() => setRemoving(current)}
              onOpenRefs={() =>
                guard(() => {
                  setRefName(current.name);
                  setView("refs");
                })
              }
            />
          ) : (
            <FormColumn>
              <Empty
                title="还没有隐私变量"
                description="把密钥、令牌交给元枢保管：agent 只看得到名字和描述，用的时候写 {{@名称}}，值只在命令执行时出现。添加后还要在工作区里启用，agent 才用得到。"
                action={
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    添加变量
                  </Button>
                }
              />
            </FormColumn>
          )}
        </SplitPane>
      </TabPanel>
      <TabPanel idBase="vr" id="refs" value={view} className="st-pane">
        <ListColumn>
          <ReferencesPane
            hostLabel={(id) => hosts[id] ?? id}
            name={refName}
            onClearName={() => setRefName(null)}
          />
        </ListColumn>
      </TabPanel>

      {adding && (
        <AddVariableDialog
          store={store}
          all={variables}
          workspaces={workspaces}
          now={now}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setQuery("");
            setSel(id);
            setView("vars");
          }}
        />
      )}
      <RotateModal
        target={rotating}
        store={store}
        onClose={() => setRotating(null)}
      />
      {renaming !== null && (
        <RenameGroupDialog
          from={renaming}
          existing={groups}
          store={store}
          onClose={() => setRenaming(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `删除 {{@${removing.name}}}` : ""}
        confirmLabel="删除"
        busy={busy}
        error={confirmError}
        onClose={closeConfirm}
        onConfirm={() =>
          removing && void confirm(() => store.remove(removing.id), "已删除")
        }
      >
        删除名称和值，不能撤销。
        {removing && removing.workspaces.length > 0
          ? `它在 ${removing.workspaces.length} 个工作区里的启用也一并取消。`
          : ""}
        历史引用记录保留，但不再对应变量。
      </ConfirmDialog>
      <ConfirmDialog
        open={dissolving !== null}
        title={dissolving ? `解散变量组「${dissolving}」` : ""}
        confirmLabel="解散"
        busy={busy}
        error={confirmError}
        onClose={closeConfirm}
        onConfirm={() =>
          dissolving &&
          void confirm(() => store.dissolveGroup(dissolving), "已解散")
        }
      >
        组里的变量回到「未分组」，变量本身和它们在各工作区的启用都不变。
      </ConfirmDialog>
    </Page>
  );
}
