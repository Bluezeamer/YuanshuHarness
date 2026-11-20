import { useReducer, useState } from "react";
import {
  Button,
  Chip,
  ConfirmDialog,
  Field,
  InlineNotice,
  Input,
  PeekCard,
  Textarea,
  toast,
} from "../../../ui";
import { FormColumn, SplitPane } from "../../settings/frame/layout";
import { useBindDirty, useLeaveGuard } from "../../settings/frame/leave";
import { RailList, type RailSection } from "../../settings/frame/RailList";
import { SaveBar } from "../../settings/frame/SaveBar";
import { useDraft } from "../../settings/frame/useDraft";
import { card, LIB } from "../studioData";
import { newLibCard } from "./data";

function CardDetail({
  id,
  onSaved,
  onCopy,
}: {
  id: string;
  onSaved: () => void;
  onCopy: () => void;
}) {
  const c = card(id);
  const d = useDraft({ title: c.title, body: c.body }, async (x) => {
    Object.assign(c, { title: x.title.trim() || c.title, body: x.body });
    onSaved();
    return null;
  });
  useBindDirty({ dirty: d.dirty, save: d.save, discard: d.discard });
  return (
    <FormColumn>
      <div className="sp-dh">
        <span className="t-page">{c.title}</span>
        {c.builtin && <Chip>内置</Chip>}
      </div>
      <p className="t-aux sp-dsub">
        卡片库 · {c.lib} · {c.body.length} 字 · 被 {c.usedBy} 个预设引用
        {c.usedBy > 1 && "，改动会同时影响它们"}
      </p>
      {c.builtin && (
        <InlineNotice className="sp-dnote">
          内置卡片只读。要改，先
          <Button size="sm" variant="ghost" onClick={onCopy}>
            复制一份
          </Button>
          再编辑。
        </InlineNotice>
      )}
      <div className="sp-dfields">
        <Field label="标题">
          {(f) => (
            <Input
              {...f}
              disabled={c.builtin}
              value={d.draft.title}
              onChange={(e) =>
                d.setDraft({ ...d.draft, title: e.target.value })
              }
            />
          )}
        </Field>
        <Field label="内容">
          {(f) => (
            <Textarea
              {...f}
              mono
              rows={16}
              disabled={c.builtin}
              value={d.draft.body}
              onChange={(e) => d.setDraft({ ...d.draft, body: e.target.value })}
            />
          )}
        </Field>
      </div>
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
    </FormColumn>
  );
}

// 卡片库：主从页。左边按卡片库分组的标准列表，右边改标题与内容；内置卡片只读，可复制后改。
export function CardsTab() {
  const guard = useLeaveGuard();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(LIB[0]?.id ?? null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const copy = (id: string) => {
    const c = card(id);
    const nid = newLibCard(`${c.title}（副本）`, c.body, c.lib);
    bump();
    setSel(nid);
    toast("已复制，可以编辑了", { tone: "ok" });
  };

  const shown = LIB.filter(
    (c) =>
      q === "" || `${c.title}${c.body}`.toLowerCase().includes(q.toLowerCase()),
  );
  const sections: RailSection[] = [...new Set(shown.map((c) => c.lib))].map(
    (lib) => ({
      key: lib,
      name: lib,
      items: shown
        .filter((c) => c.lib === lib)
        .map((c) => ({
          id: c.id,
          label: c.title,
          sub: `${c.body.length} 字`,
          ...(c.builtin ? { trail: "内置" } : {}),
          peek: (
            <PeekCard
              title={c.title}
              text={c.body}
              facts={[
                ["所属", c.lib],
                ["引用", `${c.usedBy} 个预设`],
              ]}
            />
          ),
          menu: [
            { id: "copy", label: "复制", onSelect: () => copy(c.id) },
            {
              id: "del",
              label: "删除",
              tone: "danger" as const,
              separatorBefore: true,
              disabled: Boolean(c.builtin || c.usedBy > 0),
              ...(c.builtin
                ? { hint: "内置" }
                : c.usedBy > 0
                  ? { hint: `${c.usedBy} 个预设在用` }
                  : {}),
              onSelect: () => setDeleting(c.id),
            },
          ],
        })),
    }),
  );
  const target = deleting ? card(deleting) : null;

  return (
    <>
      <SplitPane
        rail={
          <RailList
            title="卡片库"
            total={LIB.length}
            query={q}
            onQuery={setQ}
            searchLabel="搜标题或内容"
            sections={sections}
            sel={sel}
            onSel={(id) => guard(() => setSel(id))}
            addLabel="新建卡片"
            onAdd={() => {
              const id = newLibCard("新卡片", "", "项目约定");
              bump();
              setSel(id);
            }}
            noneText="没有符合的卡片"
          />
        }
      >
        {sel && LIB.some((c) => c.id === sel) ? (
          <CardDetail
            key={sel}
            id={sel}
            onSaved={bump}
            onCopy={() => copy(sel)}
          />
        ) : (
          <p className="t-aux sp-none">从左边选一张卡片。</p>
        )}
      </SplitPane>
      <ConfirmDialog
        open={target !== null}
        title="删除卡片"
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const i = LIB.findIndex((c) => c.id === deleting);
          if (i >= 0) LIB.splice(i, 1);
          if (sel === deleting) setSel(LIB[0]?.id ?? null);
          setDeleting(null);
          bump();
        }}
      >
        删除「{target?.title}」？删除后不能恢复。
      </ConfirmDialog>
    </>
  );
}
