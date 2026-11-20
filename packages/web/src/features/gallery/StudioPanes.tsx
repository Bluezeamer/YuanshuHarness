import { useState } from "react";
import { Button, Chip, Field, InlineNotice, Segmented, Select } from "../../ui";
import {
  card,
  lineDiff,
  renderAll,
  type Segment,
  SIM_MODELS,
  type SimModel,
  whereIs,
} from "./studioData";

// 选中一张卡片：看全文，并且能跳去改。卡片是库里共用的，改它会影响所有引用它的预设。
export function CardPane({
  id,
  segs,
  onEdit,
  onCopy,
}: {
  id: string;
  segs: Segment[];
  onEdit: (id: string) => void;
  onCopy?: () => void;
}) {
  const c = card(id);
  const where = whereIs(segs, id);
  return (
    <div className="gl-cp">
      <div className="gl-cp-h">
        <span className="t-group">{c.title}</span>
        {c.builtin && <Chip>内置</Chip>}
      </div>
      <div className="t-aux">
        卡片库 · {c.lib} · {c.body.length} 字
        {where && <> · 在这份预设里：{where}</>}
      </div>
      <pre className="gl-pre t-code">{c.body}</pre>
      <div className="t-aux">
        被 {c.usedBy} 个预设引用
        {c.usedBy > 1 ? "，改动会同时影响它们。" : "。"}
      </div>
      {c.builtin ? (
        <InlineNotice>
          内置卡片只读。要改，先
          <Button size="sm" variant="ghost" onClick={onCopy}>
            复制一份
          </Button>
          再替换进来。
        </InlineNotice>
      ) : (
        <div className="gl-cp-act">
          <Button variant="outline" onClick={() => onEdit(c.id)}>
            编辑这张卡片
          </Button>
          <span className="t-aux">
            改的是卡片库里的这一张，别的预设里也会变
          </span>
        </div>
      )}
    </div>
  );
}

// 整份预设拼出来的样子，按所选模型求值；system 与 user 两个通道分开看。
export function OverallPane({
  segs,
  model,
  onModel,
  modelLabel = "按这个模型求值",
  note,
  title = "整体预览",
  single,
  noModel,
}: {
  segs: Segment[];
  model: string;
  onModel: (k: string) => void;
  modelLabel?: string;
  note?: string;
  title?: string;
  /** 只有一份内容（AGENTS.md）时不分通道 */
  single?: boolean;
  /** 内容不随模型变（没有分组）时不选模型 */
  noModel?: boolean;
}) {
  const [ch, setCh] = useState("system");
  const m = (SIM_MODELS.find((x) => x.key === model) ??
    SIM_MODELS[0]) as SimModel;
  const out = renderAll(segs, m);
  const groups = segs.flatMap((s) =>
    s.items.filter((it) => it.kind === "group"),
  );
  // 没有分组时内容不随模型变，选模型没有意义
  const hideModel = noModel || groups.length === 0;
  return (
    <div className="gl-cp">
      <div className="gl-prev-h">
        <span className="t-group">{title}</span>
        {!single && (
          <Segmented
            size="sm"
            aria-label="通道"
            options={[
              { value: "system", label: "system" },
              { value: "user", label: "user" },
            ]}
            value={ch}
            onChange={setCh}
          />
        )}
      </div>
      {!hideModel && (
        <Field label={modelLabel}>
          {(c) => (
            <Select
              {...c}
              value={model}
              onChange={onModel}
              options={SIM_MODELS.map((x) => ({
                value: x.key,
                label: x.label,
              }))}
            />
          )}
        </Field>
      )}
      <div className="t-aux">
        {note ??
          (groups.length === 0
            ? "还没有分组，内容不随模型变化。"
            : `共 ${groups.length} 个分组，每组按所选模型选出一张。换模型时前缀会重建。`)}
      </div>
      <pre className="gl-pre t-code">
        {(ch === "system" ? out.system : out.user) || "（这个通道是空的）"}
      </pre>
    </div>
  );
}

const modelOptions = SIM_MODELS.map((x) => ({ value: x.key, label: x.label }));
const modelOf = (k: string): SimModel =>
  (SIM_MODELS.find((x) => x.key === k) ?? SIM_MODELS[0]) as SimModel;

// 条件变了（例如会话中途换了模型）会怎样：对话末尾追加一条尾注，写明新旧两份内容的差异，前面已发出的不动。
export function DiffPane({
  segs,
  from,
  to,
  onFrom,
  onTo,
}: {
  segs: Segment[];
  from: string;
  to: string;
  onFrom: (k: string) => void;
  onTo: (k: string) => void;
}) {
  const a = renderAll(segs, modelOf(from)).system;
  const b = renderAll(segs, modelOf(to)).system;
  const d = lineDiff(a, b);
  const changed = d.some((x) => x.t !== "same");
  return (
    <div className="gl-cp">
      <Field label="会话创建时的模型">
        {(c) => (
          <Select
            {...c}
            value={from}
            onChange={onFrom}
            options={modelOptions}
          />
        )}
      </Field>
      <Field label="中途换成">
        {(c) => (
          <Select {...c} value={to} onChange={onTo} options={modelOptions} />
        )}
      </Field>
      <div className="t-aux">
        条件变了，就在对话末尾追加一条尾注，里面写明差异；前面已经发出的内容不动。对话里也会显示这份差异。
      </div>
      <pre className="gl-pre gl-diff t-code">
        {changed
          ? d.map((x) => (
              <div key={x.n} className="gl-d" data-t={x.t}>
                {x.t === "add" ? "+ " : x.t === "del" ? "- " : "  "}
                {x.s || " "}
              </div>
            ))
          : "两个模型下的内容相同，不会追加尾注。"}
      </pre>
    </div>
  );
}
