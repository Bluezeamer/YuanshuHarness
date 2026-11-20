import { useEffect, useState } from "react";
import { shortVersion } from "../../../../api/skillLibrary";
import { Button, Dot, Empty, Loading, PeekCard } from "../../../../ui";
import { PlusIcon } from "../../../../ui/icons";
import { FormColumn, SplitPane } from "../../frame/layout";
import { notify } from "../../frame/notify";
import { RailList } from "../../frame/RailList";
import { autoCheckUpdates } from "../common/autoCheck";
import { useSnapshot } from "../common/hooks";
import { toggleEnabled, update } from "./actions";
import {
  inSyncCount,
  isUpdatable,
  matchesSkill,
  originText,
  statusOf,
} from "./model";
import { SkillDetail, TONE } from "./SkillDetail";
import { SkillInfoModal } from "./SkillInfoModal";
import { SkillInstallModal } from "./SkillInstallModal";
import { SkillRemoveDialog } from "./SkillRemoveDialog";
import { SkillVersionsDialog } from "./SkillVersionsDialog";
import type { SkillsStore } from "./store";

type Dialog =
  | { kind: "install" }
  | { kind: "files" | "versions" | "remove"; name: string };

// 技能页签：左列表 + 右详情。分发到各环境是详情里的一节，不在列表里摊成列。
export function SkillsTab({ store }: { store: SkillsStore }) {
  const state = useSnapshot(store);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void store
      .load()
      .then(() => autoCheckUpdates("skills", () => store.checkUpdates()));
  }, [store]);

  if (state.phase === "loading") return <Loading>正在读取技能库…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取技能库失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );

  const { skills, hosts, busy } = state;
  const selected = skills.find((s) => s.name === sel) ?? skills[0] ?? null;
  // 把隐含的默认选中固化下来：列表重排（装了新的、卸了旧的）时详情不会跳到别的技能
  if (selected && selected.name !== sel) setSel(selected.name);
  const close = () => setDialog(null);
  const target =
    dialog && "name" in dialog
      ? skills.find((s) => s.name === dialog.name)
      : undefined;

  const check = async () => {
    setChecking(true);
    const r = await store.checkUpdates();
    setChecking(false);
    notify(
      r.failed.length
        ? `检查了 ${r.checked} 个来源，${r.failed.length} 个没查到：${r.failed
            .map((f) => `${f.name}（${f.message}）`)
            .join("、")}`
        : null,
      `检查完成：${r.checked} 个来源`,
    );
  };

  const items = skills
    .filter((s) => matchesSkill(s, query, hosts))
    .map((s) => {
      const st = statusOf(s, busy[s.name] ?? null);
      const o = originText(s.origin, hosts);
      const total = s.dist?.length ?? 0;
      return {
        id: s.name,
        label: s.name,
        sub: `${s.scope === "global" ? "全局 · " : ""}${o.kind} · ${s.version === null ? "不跟踪版本" : shortVersion(s.version)}`,
        trail: (
          <span className="tp-trail">
            {total > 0 && (
              <span className="t-mono">
                {inSyncCount(s)}/{total}
              </span>
            )}
            <Dot tone={TONE[st.key]} label={st.text} />
          </span>
        ),
        peek: (
          <PeekCard
            title={s.name}
            text={s.description}
            facts={[
              ["范围", s.scope === "global" ? "全局" : "按工作区勾选"],
              ["来源", `${o.kind} · ${o.name}`],
              [
                "版本",
                `${s.version === null ? "不跟踪版本" : shortVersion(s.version)}${s.lockedVersion !== null ? "（已锁定）" : ""}`,
              ],
              ...(total > 0
                ? [["分发", `${inSyncCount(s)}/${total} 个环境一致`] as const]
                : []),
              ["状态", st.text],
            ]}
          />
        ),
        menu: [
          ...(isUpdatable(s)
            ? [
                {
                  id: "update",
                  label: `更新到 ${s.latestVersion}`,
                  onSelect: () =>
                    void update(store, s).then((p) =>
                      notify(p, `已更新到 ${s.latestVersion}`),
                    ),
                },
              ]
            : []),
          {
            id: "toggle",
            label: s.enabled ? "禁用" : "启用",
            onSelect: () =>
              void toggleEnabled(store, s).then((p) =>
                notify(p, s.enabled ? "已禁用" : "已启用"),
              ),
          },
          {
            id: "remove",
            label: "卸载",
            tone: "danger" as const,
            separatorBefore: true,
            onSelect: () => setDialog({ kind: "remove", name: s.name }),
          },
        ],
      };
    });

  return (
    <>
      <SplitPane
        rail={
          <RailList
            title="技能"
            total={skills.length}
            menu={[
              {
                id: "check",
                label: "检查更新",
                disabled: checking,
                onSelect: () => void check(),
              },
            ]}
            query={query}
            onQuery={setQuery}
            searchLabel="筛选名称、描述或来源"
            sections={items.length > 0 ? [{ key: "all", items }] : []}
            sel={selected?.name ?? null}
            onSel={setSel}
            addLabel="安装技能"
            onAdd={() => setDialog({ kind: "install" })}
            noneText={skills.length === 0 ? "还没有技能" : "没有匹配的技能"}
          />
        }
      >
        {selected ? (
          <SkillDetail
            key={selected.name}
            skill={selected}
            hosts={hosts}
            store={store}
            busy={busy[selected.name]}
            onFiles={() => setDialog({ kind: "files", name: selected.name })}
            onVersions={() =>
              setDialog({ kind: "versions", name: selected.name })
            }
            onRemove={() => setDialog({ kind: "remove", name: selected.name })}
          />
        ) : (
          <FormColumn>
            <Empty
              title="技能库是空的"
              description="技能是 SKILL.md 加配套文件：存在 Server 的库里，会话用到时补到所在环境。可以从 npm、git、本地目录安装，或把某个环境上已有的技能纳入。"
              action={
                <Button
                  variant="primary"
                  icon={<PlusIcon size={12} />}
                  onClick={() => setDialog({ kind: "install" })}
                >
                  安装技能
                </Button>
              }
            />
          </FormColumn>
        )}
      </SplitPane>
      {dialog?.kind === "install" && (
        <SkillInstallModal
          store={store}
          hosts={hosts}
          onClose={close}
          onInstalled={(name) => {
            close();
            setQuery("");
            setSel(name);
            notify(null, `${name} 已装进库`);
          }}
        />
      )}
      {dialog?.kind === "files" && target && (
        <SkillInfoModal
          name={target.name}
          description={target.description}
          store={store}
          onClose={close}
        />
      )}
      {dialog?.kind === "versions" && target && (
        <SkillVersionsDialog skill={target} store={store} onClose={close} />
      )}
      {dialog?.kind === "remove" && target && (
        <SkillRemoveDialog
          skills={[target]}
          hosts={hosts}
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
