import { useState } from "react";
import type { StudioNode } from "../../../api/studio";
import {
  Button,
  Chip,
  Field,
  InlineNotice,
  Segmented,
  Select,
} from "../../../ui";
import {
  type ModelRef,
  type ProviderChoice,
  parseKey,
  renderAll,
  whereIs,
} from "./model/eval";
import { useStudio } from "./useStudio";

export const modelOptions = (providers: ProviderChoice[]) =>
  providers.flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}/${m}`,
      label: m,
      hint: p.name,
    })),
  );

// 选中一张卡片：看全文，并且能直接改。卡片是库里共用的，改它会影响所有引用它的预设。
export function CardPane({
  id,
  segs,
  onEdit,
  onCopy,
}: {
  id: string;
  segs: StudioNode[];
  onEdit: () => void;
  onCopy: () => void;
}) {
  const { cards } = useStudio();
  const c = cards.get(id);
  if (!c)
    return <div className="sd-cp t-aux">这张卡片已经不在卡片库里了。</div>;
  const where = whereIs(segs, id);
  return (
    <div className="sd-cp">
      <div className="sd-cp-h">
        <span className="t-group">{c.title}</span>
        {c.builtin && <Chip>内置</Chip>}
      </div>
      <div className="t-aux">
        卡片库 · {c.group} · {c.body.length} 字
        {where && <> · 在这份预设里：{where}</>}
      </div>
      <pre className="sd-pre t-code">{c.body || "（空）"}</pre>
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
        <div className="sd-cp-act">
          <Button variant="outline" onClick={onEdit}>
            编辑这张卡片
          </Button>
          <span className="t-aux">
            在原处打开，保存后回到这里，页面上没保存的编辑不会丢
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
  title = "整体预览",
  modelLabel = "按这个模型求值",
  note,
  single,
}: {
  segs: StudioNode[];
  model: string;
  onModel: (key: string) => void;
  title?: string;
  modelLabel?: string;
  note?: string;
  /** 只有一份内容（AGENTS.md）时不分通道 */
  single?: boolean;
}) {
  const { cards, providers } = useStudio();
  const [ch, setCh] = useState("system");
  const ref: ModelRef | null = model ? parseKey(model) : null;
  const out = renderAll(segs, ref, (id) => cards.get(id)?.body ?? "");
  const groups = segs.flatMap((s) =>
    s.items.filter((it) => it.kind === "group"),
  );
  return (
    <div className="sd-cp">
      <div className="sd-prev-h">
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
      {groups.length > 0 && (
        <Field label={modelLabel}>
          {(c) => (
            <Select
              {...c}
              value={model}
              onChange={onModel}
              options={modelOptions(providers)}
            />
          )}
        </Field>
      )}
      <div className="t-aux">
        {note ??
          (groups.length > 0
            ? `共 ${groups.length} 个分组，每组按所选模型选出一张。会话换模型时，提示词会整体重建。`
            : "没有分组，内容不随模型变化。")}
      </div>
      <pre className="sd-pre t-code">
        {(single || ch === "system" ? out.system : out.user) ||
          "（这个通道是空的）"}
      </pre>
    </div>
  );
}
