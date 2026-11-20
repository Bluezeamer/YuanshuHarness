import { Field, Segmented, Select } from "../../../../ui";
import {
  type Catalog,
  connectedProviders,
  levelsOf,
  modelSpecOf,
  settleModel,
} from "../model/catalog";
import { levelLabel } from "../model/labels";
import { type ModelValue, pickStart } from "../model/session";

const ctxLabel = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;

// 模型：跟随全局默认，或指定供应商 / 模型 / 思考级别。
export function ModelEditor({
  cat,
  value: m,
  onChange,
}: {
  cat: Catalog;
  value: ModelValue;
  onChange: (next: ModelValue) => void;
}) {
  const pick = m.mode === "pick";
  const providers = connectedProviders(cat);
  const provider = providers.find((p) => p.id === m.provider);
  const spec = modelSpecOf(cat, m.provider, m.model);
  const levels = levelsOf(spec);
  const patch = (next: Partial<ModelValue>) => onChange({ ...m, ...next });

  const switchMode = (mode: ModelValue["mode"]) => {
    if (mode === "follow") return patch({ mode });
    // 切到指定：起点是当前取值（若仍可用），否则第一个已连接供应商的第一个模型
    const start = provider
      ? settleModel(cat, m.provider, { model: m.model, reasoning: m.reasoning })
      : pickStart(cat);
    patch({ mode, ...start });
  };

  return (
    <div className="dlg-stack">
      <Segmented
        aria-label="模型取用方式"
        value={m.mode}
        onChange={switchMode}
        options={[
          { value: "follow", label: "跟随全局默认" },
          { value: "pick", label: "指定模型" },
        ]}
      />
      {!pick && (
        <p className="t-aux">用设置里的默认模型，思考级别取自默认模型。</p>
      )}
      {pick && providers.length === 0 && (
        <p className="t-aux">
          没有已连接的供应商。先到设置里连接并测试一个供应商，再回来指定模型。
        </p>
      )}
      {pick && providers.length > 0 && (
        <>
          <div className="dlg-grid3">
            <Field label="供应商">
              {(c) => (
                <Select
                  {...c}
                  value={m.provider}
                  options={[
                    ...(provider
                      ? []
                      : [
                          {
                            value: m.provider,
                            label: `${m.provider || "请选择"}（未连接）`,
                            disabled: true,
                          },
                        ]),
                    ...providers.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(v) =>
                    patch(
                      settleModel(cat, v, {
                        reasoning: m.reasoning,
                        fresh: true,
                      }),
                    )
                  }
                />
              )}
            </Field>
            <Field label="模型">
              {(c) => (
                <Select
                  {...c}
                  value={m.model}
                  options={[
                    ...(spec
                      ? []
                      : [
                          {
                            value: m.model,
                            label: m.model || "请选择",
                            disabled: true,
                          },
                        ]),
                    ...(provider?.models ?? []).map((x) => ({
                      value: x.id,
                      label: x.name,
                    })),
                  ]}
                  onChange={(v) =>
                    patch(
                      settleModel(cat, m.provider, {
                        model: v,
                        reasoning: m.reasoning,
                        fresh: true,
                      }),
                    )
                  }
                />
              )}
            </Field>
            <Field label="思考级别">
              {(c) => (
                <Select
                  {...c}
                  value={m.reasoning}
                  disabled={levels.length < 2}
                  options={levels.map((l) => ({
                    value: l,
                    label: levelLabel(l),
                  }))}
                  onChange={(v) => patch({ reasoning: v })}
                />
              )}
            </Field>
          </div>
          {spec && (
            <p className="t-aux">
              上下文 {spec.ctx ? ctxLabel(spec.ctx) : "未声明"} · 输入{" "}
              {spec.input.join("、")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
