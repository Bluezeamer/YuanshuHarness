import { useState } from "react";
import { Button, IconButton, TabPanel, Tabs } from "../../ui";
import { BackIcon } from "../../ui/icons";
import { AddCardsModal } from "./StudioAddCards";
import { BasicsTab, CapsTab } from "./StudioCaps";
import { CardPane, DiffPane, OverallPane } from "./StudioPanes";
import { SegmentBody, SegmentList, useDnd } from "./StudioTree";
import {
  AGENT_SEGMENTS,
  DEFAULT_MODEL,
  type Segment,
  SIM_MODELS,
  type SimModel,
  whereIs,
} from "./studioData";
import { insertCards } from "./studioTree";

const TABS = [
  { id: "prompt", label: "提示词" },
  { id: "caps", label: "能力", count: 13 },
  { id: "basics", label: "设定" },
];

/** 左：段列表；中：这一段的卡片与分组；右：所选卡片 / 整体预览；添加卡片是弹出页。Agent 与 AGENTS.md 共用。 */
export function PromptWorkspace({
  initial,
  flat,
  diff,
  overall,
}: {
  initial: Segment[];
  /** 只有一段（AGENTS.md）：不画左边的段列表 */
  flat?: boolean;
  /** 右栏多一页「换模型的差异」（全局 AGENTS.md：条件变了走尾注并显示差异） */
  diff?: boolean;
  overall: (p: {
    segs: Segment[];
    model: string;
    onModel: (k: string) => void;
  }) => React.ReactNode;
}) {
  const [segs, setSegs] = useState<Segment[]>(initial);
  const [cur, setCur] = useState(initial.find((s) => !s.lock)?.id ?? "");
  const [sel, setSel] = useState<string | null>(null);
  const [pane, setPane] = useState<"card" | "all" | "diff">("all");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [toModel, setToModel] = useState("anthropic/claude-sonnet-5");
  const [adding, setAdding] = useState<{
    seg: string;
    group: string | null;
  } | null>(null);
  const dnd = useDnd();
  const m = (SIM_MODELS.find((x) => x.key === model) ??
    SIM_MODELS[0]) as SimModel;
  const seg = segs.find((s) => s.id === cur) ?? (segs[0] as Segment);
  const addSeg = segs.find((s) => s.id === adding?.seg);
  const grp = addSeg?.items.find(
    (it) => it.kind === "group" && it.id === adding?.group,
  );
  const where = addSeg
    ? `${addSeg.title}${grp && grp.kind === "group" ? ` › ${grp.name}` : ""}`
    : "";
  return (
    <div className="gl-pw" data-flat={flat || undefined}>
      {!flat && (
        <SegmentList
          segs={segs}
          current={seg.id}
          onCurrent={setCur}
          onChange={setSegs}
          dnd={dnd}
        />
      )}
      <SegmentBody
        segs={segs}
        seg={seg}
        onChange={setSegs}
        selected={sel}
        onSelect={(id) => {
          setSel(id);
          setPane("card");
        }}
        onEdit={() => setPane("card")}
        onAdd={(s, g) => setAdding({ seg: s, group: g })}
        model={m}
        dnd={dnd}
        {...(flat ? { bare: true } : {})}
      />
      <aside className="gl-prev">
        <div className="gl-prev-tabs">
          <Tabs
            idBase="gl-pane"
            aria-label="右栏"
            value={pane}
            onChange={(v) => setPane(v as "card" | "all" | "diff")}
            tabs={[
              { id: "card", label: "所选卡片" },
              { id: "all", label: "整体预览" },
              ...(diff ? [{ id: "diff", label: "换模型的差异" }] : []),
            ]}
          />
        </div>
        {pane === "card" ? (
          sel && whereIs(segs, sel) ? (
            <CardPane id={sel} segs={segs} onEdit={() => {}} />
          ) : (
            <div className="gl-cp t-aux">
              点一张卡片，在这里看全文并跳去编辑。
            </div>
          )
        ) : pane === "diff" ? (
          <DiffPane
            segs={segs}
            from={model}
            to={toModel}
            onFrom={setModel}
            onTo={setToModel}
          />
        ) : (
          overall({ segs, model, onModel: setModel })
        )}
      </aside>
      <AddCardsModal
        open={adding !== null}
        onClose={() => setAdding(null)}
        segs={segs}
        where={where}
        onAdd={(ids) => {
          if (adding)
            setSegs(insertCards(segs, ids, { ...adding, before: null }));
          setAdding(null);
        }}
      />
    </div>
  );
}

// 视图 1：Agent 编辑器。提示词页是左右布局，另有能力、设定两页。
export function AgentEditor() {
  const [tab, setTab] = useState("prompt");
  return (
    <div className="gl-ed">
      <div className="gl-ed-bar">
        <IconButton label="返回 Agent 列表" icon={<BackIcon />} />
        <span className="t-page">coder-full</span>
        <span className="t-aux">完整的编码代理 · 5 个会话在用</span>
        <span className="gl-sp" />
        <Button size="sm" variant="ghost">
          复制为新 Agent
        </Button>
      </div>
      <Tabs
        idBase="gl-agent"
        aria-label="Agent 编辑"
        tabs={TABS}
        value={tab}
        onChange={setTab}
      />
      <TabPanel idBase="gl-agent" id="prompt" value={tab} className="gl-tabp">
        <PromptWorkspace
          initial={AGENT_SEGMENTS}
          overall={(p) => <OverallPane {...p} />}
        />
      </TabPanel>
      <TabPanel idBase="gl-agent" id="caps" value={tab} className="gl-tabp">
        <CapsTab />
      </TabPanel>
      <TabPanel idBase="gl-agent" id="basics" value={tab} className="gl-tabp">
        <BasicsTab />
      </TabPanel>
    </div>
  );
}
