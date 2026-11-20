import { useState } from "react";
import type { ModelSpec, ThinkingLevelName } from "../../../api/providers";
import {
  Button,
  Field,
  FilterChip,
  InlineNotice,
  Input,
  Modal,
  Select,
  Switch,
} from "../../../ui";
import {
  blankModel,
  DEFAULT_LEVELS,
  hasVision,
  LEVEL_ORDER,
  levelsInOrder,
  parseCount,
} from "./model";

const COUNT_ERROR =
  "上下文和输出要填 token 数：纯数字，或带 K / M 单位（如 256K、1M），留空表示稍后补全";

// 添加 / 编辑一个模型：id、上下文、输出、图片、思考（支持哪几档、换到它时默认哪一档、各档发给端点的值）。
// 保存才提交；已添加的模型 id 不能改。
export function ModelDialog({
  base,
  taken,
  onSave,
  onClose,
}: {
  /** 编辑时是现有规格；添加时为 undefined */
  base: ModelSpec | undefined;
  /** 已有的模型 id，添加时用来拦重复 */
  taken: ReadonlySet<string>;
  onSave: (spec: ModelSpec) => Promise<string | null>;
  onClose: () => void;
}) {
  const [id, setId] = useState(base?.id ?? "");
  const [ctx, setCtx] = useState(base && base.ctx > 0 ? String(base.ctx) : "");
  const [out, setOut] = useState(base && base.out > 0 ? String(base.out) : "");
  const [vision, setVision] = useState(base ? hasVision(base) : false);
  const [levels, setLevels] = useState<ThinkingLevelName[]>(base?.levels ?? []);
  const [def, setDef] = useState<ThinkingLevelName | "">(
    base?.defaultLevel ?? "",
  );
  const [map, setMap] = useState<Record<string, string>>({ ...base?.map });
  const [mapping, setMapping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const think = levels.length > 0;

  const toggleLevel = (l: ThinkingLevelName) => {
    const has = levels.includes(l);
    const next = has
      ? levels.filter((x) => x !== l)
      : levelsInOrder([...levels, l]);
    setLevels(next);
    if (has) {
      setMap(Object.fromEntries(Object.entries(map).filter(([k]) => k !== l)));
      if (def === l) setDef("");
    }
  };

  const submit = async () => {
    const key = id.trim();
    const c = parseCount(ctx);
    const o = parseCount(out);
    if (!key) return setError("先填模型 ID");
    if (!base && taken.has(key)) return setError(`模型 ${key} 已在列表里`);
    if (c === null || o === null) return setError(COUNT_ERROR);

    const kept = Object.fromEntries(
      Object.entries(map)
        .map(([k, v]) => [k, v.trim()])
        .filter(
          ([k, v]) => v !== "" && levels.includes(k as ThinkingLevelName),
        ),
    );
    const {
      map: _m,
      defaultLevel: _d,
      ...rest
    } = base ?? blankModel(key, "manual");
    const input = new Set(rest.input);
    if (vision) input.add("image");
    else input.delete("image");
    const patch: Partial<ModelSpec> = {
      ctx: c,
      out: o,
      input: [...input] as ModelSpec["input"],
      reasoning: think,
      levels,
      ...(Object.keys(kept).length ? { map: kept } : {}),
      ...(think && def ? { defaultLevel: def } : {}),
    };
    setBusy(true);
    setError(null);
    const err = await onSave({ ...rest, id: key, ...patch });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={base ? "编辑模型" : "添加模型"}
      size="sm"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
          >
            {base ? "保存" : "添加"}
          </Button>
        </>
      }
    >
      <div className="pv-form">
        <Field
          label="模型 ID"
          hint={base ? "创建后不能改" : "发给端点的名字，要和服务端一致"}
        >
          {(c) => (
            <Input
              {...c}
              large
              mono
              readOnly={!!base}
              value={id}
              placeholder="例：qwen3-coder-480b"
              onChange={(e) => setId(e.target.value)}
            />
          )}
        </Field>
        <div className="pv-form-2">
          <Field label="上下文长度（token）" hint="可写 256K、1M">
            {(c) => (
              <Input
                {...c}
                large
                mono
                value={ctx}
                placeholder="待补全"
                onChange={(e) => setCtx(e.target.value)}
              />
            )}
          </Field>
          <Field label="最大输出（token）" hint="可写 32K、64K">
            {(c) => (
              <Input
                {...c}
                large
                mono
                value={out}
                placeholder="待补全"
                onChange={(e) => setOut(e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="pv-form-sw">
          <div className="pv-form-line">
            <span className="t-entry">支持图片输入</span>
            <Switch
              checked={vision}
              onChange={setVision}
              aria-label="支持图片输入"
            />
          </div>
          <div className="pv-form-line">
            <span className="t-entry">支持思考</span>
            <Switch
              checked={think}
              onChange={(on) => {
                setLevels(on ? [...DEFAULT_LEVELS] : []);
                if (!on) {
                  setMap({});
                  setDef("");
                }
              }}
              aria-label="支持思考"
            />
          </div>
        </div>

        {think && (
          <>
            <Field
              label="思考档位"
              hint="只勾选模型接受的档位；对话里只能在勾选的档位之间切换"
            >
              <div className="pv-levels">
                {LEVEL_ORDER.map((l) => (
                  <FilterChip
                    key={l}
                    pressed={levels.includes(l)}
                    onClick={() => toggleLevel(l)}
                  >
                    {l}
                  </FilterChip>
                ))}
              </div>
            </Field>
            <Field
              label="默认档位"
              hint="在选择器里换到这个模型时，思考档位先落在这一档"
            >
              {(c) => (
                <Select
                  {...c}
                  value={def}
                  onChange={(v) => setDef(v as ThinkingLevelName | "")}
                  options={[
                    { value: "", label: "不指定" },
                    ...levels.map((l) => ({ value: l, label: l })),
                  ]}
                />
              )}
            </Field>
            {levels.some((l) => l !== "off") && (
              <div className="pv-map">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={mapping}
                  onClick={() => setMapping(!mapping)}
                >
                  {mapping ? "收起各档的取值" : "各档发给端点的取值"}
                </Button>
                {mapping && (
                  <div className="pv-map-grid">
                    {levels
                      .filter((l) => l !== "off")
                      .map((l) => (
                        <div key={l} className="pv-map-row">
                          <span className="t-mono">{l}</span>
                          <Input
                            mono
                            aria-label={`${l} 档的取值`}
                            value={map[l] ?? ""}
                            placeholder={l}
                            onChange={(e) =>
                              setMap({ ...map, [l]: e.target.value })
                            }
                          />
                        </div>
                      ))}
                    <p className="t-aux">
                      留空就按档位名发。端点要的是别的写法（数字预算之类）才需要填。
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </div>
    </Modal>
  );
}
