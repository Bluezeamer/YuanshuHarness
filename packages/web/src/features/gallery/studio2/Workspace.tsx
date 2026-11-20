import { useReducer, useState } from "react";
import { ConfirmDialog, Tabs } from "../../../ui";
import { AddCardsModal } from "../StudioAddCards";
import { CardPane, OverallPane } from "../StudioPanes";
import { SegmentBody, SegmentList, useDnd } from "../StudioTree";
import {
  card,
  DEFAULT_MODEL,
  LIB,
  type Segment,
  SIM_MODELS,
  type SimModel,
  whereIs,
} from "../studioData";
import { insertCards } from "../studioTree";
import { CardEditDialog, SegDialog } from "./Dialogs";
import { swapCard } from "./data";

/**
 * 提示词编辑区：左 = 段列表，中 = 这一段的卡片，右 = 所选卡片 / 整体预览。
 * flat = 只有一段（不画段列表）；plain = 固定文本（没有分组与按模型预览，两份 AGENTS.md）。
 * 三栏各自滚动；左缘落在页面留白上。
 */
export function Workspace({
  segs,
  onChange,
  flat,
  plain,
  overall,
}: {
  segs: Segment[];
  onChange: (next: Segment[]) => void;
  flat?: boolean;
  plain?: boolean;
  overall?: { title?: string; modelLabel?: string; note?: string };
}) {
  const [cur, setCur] = useState(segs.find((s) => !s.lock)?.id ?? "");
  const [sel, setSel] = useState<string | null>(null);
  const [pane, setPane] = useState<"card" | "all">("all");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [adding, setAdding] = useState<{
    seg: string;
    group: string | null;
  } | null>(null);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [segDlg, setSegDlg] = useState<{ editing: Segment | null } | null>(
    null,
  );
  const [removing, setRemoving] = useState<Segment | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const dnd = useDnd();

  const seg =
    segs.find((s) => s.id === cur) ??
    segs.find((s) => !s.lock) ??
    (segs[0] as Segment);
  const addSeg = segs.find((s) => s.id === adding?.seg);
  const grp = addSeg?.items.find(
    (it) => it.kind === "group" && it.id === adding?.group,
  );
  const where = addSeg
    ? `${addSeg.title}${grp && grp.kind === "group" ? ` › ${grp.name}` : ""}`
    : "";
  const simModel = (SIM_MODELS.find((x) => x.key === model) ??
    SIM_MODELS[0]) as SimModel;

  const copyAndSwap = (id: string) => {
    const c = card(id);
    const nid = `c-${Math.random().toString(36).slice(2, 8)}`;
    LIB.push({
      ...c,
      id: nid,
      title: `${c.title}（副本）`,
      builtin: false,
      usedBy: 1,
    });
    onChange(swapCard(segs, id, nid));
    setSel(nid);
  };

  return (
    <div className="sp-pw" data-flat={flat || undefined}>
      {!flat && (
        <div className="sp-col sp-col-segs">
          <SegmentList
            segs={segs}
            current={seg.id}
            onCurrent={setCur}
            onChange={onChange}
            dnd={dnd}
            onAdd={() => setSegDlg({ editing: null })}
            onEdit={(id) =>
              setSegDlg({ editing: segs.find((s) => s.id === id) ?? null })
            }
            onRemove={(id) =>
              setRemoving(segs.find((s) => s.id === id) ?? null)
            }
          />
        </div>
      )}
      <div className="sp-col sp-col-cards">
        <SegmentBody
          segs={segs}
          seg={seg}
          onChange={onChange}
          selected={sel}
          onSelect={(id) => {
            setSel(id);
            setPane("card");
          }}
          onEdit={(id) => {
            setSel(id);
            setEditingCard(id);
          }}
          onAdd={(s, g) => setAdding({ seg: s, group: g })}
          model={simModel}
          dnd={dnd}
          groups={!plain}
          {...(flat ? { bare: true } : {})}
        />
      </div>
      <aside className="sp-prev">
        <div className="sp-prev-tabs">
          <Tabs
            idBase="sp-pane"
            aria-label="右栏"
            value={pane}
            onChange={(v) => setPane(v as "card" | "all")}
            tabs={[
              { id: "card", label: "所选卡片" },
              { id: "all", label: "整体预览" },
            ]}
          />
        </div>
        <div className="sp-prev-body">
          {pane === "card" ? (
            sel && whereIs(segs, sel) ? (
              <CardPane
                id={sel}
                segs={segs}
                onEdit={setEditingCard}
                onCopy={() => copyAndSwap(sel)}
              />
            ) : (
              <p className="t-aux">点一张卡片，在这里看全文并直接改。</p>
            )
          ) : (
            <OverallPane
              segs={segs}
              model={model}
              onModel={setModel}
              {...(flat ? { single: true } : {})}
              {...(plain ? { noModel: true } : {})}
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
      <CardEditDialog
        key={editingCard ?? "none"}
        id={editingCard}
        onClose={() => setEditingCard(null)}
        onSaved={bump}
      />
      {segDlg && (
        <SegDialog
          key={segDlg.editing?.id ?? "new"}
          open
          editing={segDlg.editing}
          onClose={() => setSegDlg(null)}
          onSubmit={(v) => {
            const ed = segDlg.editing;
            if (ed)
              onChange(segs.map((s) => (s.id === ed.id ? { ...s, ...v } : s)));
            else {
              const id = `seg-${Math.random().toString(36).slice(2, 6)}`;
              onChange([...segs, { id, ...v, items: [] }]);
              setCur(id);
            }
            setSegDlg(null);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title="删除这一段"
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            onChange(segs.filter((s) => s.id !== removing.id));
            if (cur === removing.id) setCur("");
          }
          setRemoving(null);
        }}
      >
        删除「{removing?.title}
        」：段里的卡片只是从这份预设里拿掉，卡片库里还在。保存后生效。
      </ConfirmDialog>
    </div>
  );
}
