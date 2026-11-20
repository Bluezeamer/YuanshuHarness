import { useState } from "react";
import { copyCard, type StudioNode } from "../../../api/studio";
import { ConfirmDialog, Tabs } from "../../../ui";
import { AddCardsModal } from "./AddCardsModal";
import { CardEditorModal } from "./CardEditorModal";
import { type ModelRef, parseKey } from "./model/eval";
import {
  addSegment,
  insertCards,
  newId,
  patchSegment,
  removeSegment,
  replaceCard,
} from "./model/tree";
import { CardPane, OverallPane } from "./Panes";
import { SegmentBody } from "./SegmentBody";
import { SegmentDialog, type SegmentDraft } from "./SegmentDialog";
import { SegmentList } from "./SegmentList";
import { useDnd } from "./useDnd";
import { useStudio } from "./useStudio";

export interface OverallOptions {
  title?: string;
  modelLabel?: string;
  note?: string;
}

/**
 * 提示词编辑区：左 = 段列表，中 = 这一段的卡片与分组，右 = 所选卡片 / 整体预览；添加卡片是弹出页。
 * 各种预设共用这一个组件；segs 由外面的草稿持有。三栏各自滚动，第一栏的左缘落在页面留白上。
 */
export function PromptWorkspace({
  segs,
  onChange,
  flat,
  noGroups,
  overall,
}: {
  segs: StudioNode[];
  onChange: (next: StudioNode[]) => void;
  /** 只有一段（AGENTS.md、模式）：不画左边的段列表，也不能增删段 */
  flat?: boolean;
  /** 固定文本（两份 AGENTS.md）：不能建分组 */
  noGroups?: boolean;
  overall?: OverallOptions;
}) {
  const { cards, defaultModel, providers, reload } = useStudio();
  const firstModel = providers[0]?.models[0];
  const [model, setModel] = useState(
    defaultModel
      ? `${defaultModel.provider}/${defaultModel.model}`
      : firstModel && providers[0]
        ? `${providers[0].id}/${firstModel}`
        : "",
  );
  const m: ModelRef | null = model ? parseKey(model) : null;
  const [cur, setCur] = useState(segs.find((s) => !s.builtin)?.id ?? "");
  const [sel, setSel] = useState<string | null>(null);
  const [pane, setPane] = useState<"card" | "all">("all");
  const [adding, setAdding] = useState<{
    seg: string;
    group: string | null;
  } | null>(null);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [segDialog, setSegDialog] = useState<{
    editing: StudioNode | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<StudioNode | null>(null);
  const dnd = useDnd();

  const seg = segs.find((s) => s.id === cur) ?? (segs[0] as StudioNode);
  const addSeg = segs.find((s) => s.id === adding?.seg);
  const grp = addSeg?.items.find(
    (it) => it.kind === "group" && it.id === adding?.group,
  );
  const where = addSeg
    ? `${addSeg.title}${grp?.kind === "group" ? ` › ${grp.name}` : ""}`
    : "";

  const submitSegment = (d: SegmentDraft) => {
    const editing = segDialog?.editing;
    if (editing) onChange(patchSegment(segs, editing.id, d));
    else {
      const id = newId("seg");
      onChange(addSegment(segs, { id, ...d }));
      setCur(id);
    }
    setSegDialog(null);
  };

  const copyAndReplace = async (id: string) => {
    const r = await copyCard(id);
    if (!r.ok) return;
    await reload();
    onChange(replaceCard(segs, id, r.data.id));
    setSel(r.data.id);
  };

  return (
    <div className="sd-pw" data-flat={flat || undefined}>
      {!flat && (
        <div className="sd-col sd-col-segs">
          <SegmentList
            segs={segs}
            current={seg.id}
            onCurrent={setCur}
            onChange={onChange}
            onAdd={() => setSegDialog({ editing: null })}
            dnd={dnd}
          />
        </div>
      )}
      <div className="sd-col sd-col-cards">
        <SegmentBody
          segs={segs}
          seg={seg}
          onChange={onChange}
          selected={sel}
          onSelect={(id) => {
            setSel(id);
            setPane("card");
          }}
          onEdit={setEditingCard}
          onAdd={(s, g) => setAdding({ seg: s, group: g })}
          onEditSegment={(id) =>
            setSegDialog({ editing: segs.find((s) => s.id === id) ?? null })
          }
          onDeleteSegment={(id) =>
            setDeleting(segs.find((s) => s.id === id) ?? null)
          }
          model={m}
          dnd={dnd}
          {...(noGroups ? { groups: false } : {})}
          {...(flat ? { bare: true } : {})}
        />
      </div>
      <aside className="sd-prev">
        <div className="sd-prev-tabs">
          <Tabs
            idBase="sd-pane"
            aria-label="右栏"
            value={pane}
            onChange={(v) => setPane(v as "card" | "all")}
            tabs={[
              { id: "card", label: "所选卡片" },
              { id: "all", label: "整体预览" },
            ]}
          />
        </div>
        <div className="sd-prev-body">
          {pane === "card" ? (
            sel && cards.has(sel) ? (
              <CardPane
                id={sel}
                segs={segs}
                onEdit={() => setEditingCard(sel)}
                onCopy={() => void copyAndReplace(sel)}
              />
            ) : (
              <div className="sd-cp t-aux">
                点一张卡片，在这里看全文并直接改。
              </div>
            )
          ) : (
            <OverallPane
              segs={segs}
              model={model}
              onModel={setModel}
              {...(flat ? { single: true } : {})}
              {...overall}
            />
          )}
        </div>
      </aside>
      <AddCardsModal
        open={adding !== null}
        onClose={() => setAdding(null)}
        segs={segs}
        where={where}
        onAdd={(ids) => {
          if (adding)
            onChange(insertCards(segs, ids, { ...adding, before: null }));
          setAdding(null);
        }}
      />
      <CardEditorModal
        card={editingCard ? (cards.get(editingCard) ?? null) : null}
        onClose={() => setEditingCard(null)}
      />
      <SegmentDialog
        open={segDialog !== null}
        segs={segs}
        editing={segDialog?.editing ?? null}
        onClose={() => setSegDialog(null)}
        onSubmit={submitSegment}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="删除这一段"
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            onChange(removeSegment(segs, deleting.id));
            if (cur === deleting.id) setCur("");
          }
          setDeleting(null);
        }}
      >
        删除「{deleting?.title}
        」：段里的卡片只是从这份预设里拿掉，卡片库里还在。保存后生效。
      </ConfirmDialog>
    </div>
  );
}
