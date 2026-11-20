import { type ComponentProps, useEffect, useState } from "react";
import {
  applyFontSize,
  BASE_DEFAULT,
  BASE_MAX,
  BASE_MIN,
  type FontSettings,
  loadFontSize,
  OVERRIDE_MAX,
  OVERRIDE_MIN,
  resolveFontSize,
  saveFontSize,
} from "../../../app/fontSize";
import { Button, Input, SettingRow, Slider } from "../../../ui";

/** 两个阅读档位（= 根元素上的两条 CSS 变量），进阶区一字排开。 */
const TIERS = [
  { key: "read", label: "正文", hint: "对话正文、markdown、输入框" },
  { key: "code", label: "代码", hint: "代码块、diff、终端、编辑器" },
] as const;

type TierKey = (typeof TIERS)[number]["key"];

type PxInputProps = Omit<
  ComponentProps<"input">,
  "type" | "value" | "min" | "max" | "onChange"
> & {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

/** 数字框允许敲到一半（空串、只有小数点），失焦或回车才提交——否则每敲一位界面就抖一次。 */
function PxInput({ value, min, max, onChange, ...rest }: PxInputProps) {
  const [draft, setDraft] = useState(String(value));
  // 外部改值（拖滑块、点「恢复跟随」）要回写到输入框
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (raw: string) => {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, n));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <Input
      type="number"
      inputMode="decimal"
      step={0.5}
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
      }}
      {...rest}
    />
  );
}

/**
 * 界面字号：一个基准字号统管全局，进阶里可把正文 / 代码各自钉死。
 * 只影响要读的字，卡片外壳、图标与间距保持原尺寸，调大不会把左侧会话卡撑胖。
 * 改动立即写进根元素变量与 localStorage（键见 app/fontSize.ts），刷新后仍生效；
 * 是本机设置，不经 Server，所以不走页面的保存条。
 */
export function UiFontSection() {
  const [fs, setFs] = useState<FontSettings>(loadFontSize);
  const [advanced, setAdvanced] = useState(false);
  const size = resolveFontSize(fs);

  const update = (next: FontSettings) => {
    setFs(next);
    saveFontSize(next);
    applyFontSize(next);
  };

  // 覆盖值置 null 就是「恢复跟随基准」
  const setOverride = (key: TierKey, value: number | null) =>
    update(key === "read" ? { ...fs, read: value } : { ...fs, code: value });

  return (
    <section className="st-block" aria-label="界面字号">
      <header className="st-block-h t-group">
        <span>界面字号</span>
        <span className="st-def-grow" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? "收起进阶" : "进阶设置"}
        </Button>
      </header>
      <p className="st-def-note t-aux">
        只存在本浏览器，改了立即生效，不用保存。只放大要读的字：对话正文与代码；外壳、图标与间距不变。代码
        = 基准 × 0.875。
      </p>
      <SettingRow
        label="基准字号"
        description={`默认 ${BASE_DEFAULT}px。正文等于基准，代码按比例推导；进阶里覆盖过的档位不再跟基准走`}
      >
        <div className="st-def-fs-base">
          <Slider
            min={BASE_MIN}
            max={BASE_MAX}
            step={0.5}
            value={fs.base}
            aria-label="基准字号滑块"
            onChange={(base) => update({ ...fs, base })}
          />
          <PxInput
            aria-label="基准字号"
            min={BASE_MIN}
            max={BASE_MAX}
            value={fs.base}
            onChange={(base) => update({ ...fs, base })}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={fs.base === BASE_DEFAULT}
            onClick={() => update({ ...fs, base: BASE_DEFAULT })}
          >
            恢复默认
          </Button>
        </div>
      </SettingRow>

      <section className="st-def-fs-pv" aria-label="字号预览">
        <div>
          <p className="st-def-fs-cap t-mono">正文 · {size.read}px</p>
          <p className="st-def-fs-pv-read t-read">
            把要读的字单独放大：对话正文与其中的
            markdown、代码块、工具输出、文件列表、预览正文。
            卡片外壳与图标仍是原来的尺寸，所以调大以后左侧会话卡不会跟着变胖。
          </p>
        </div>
        <div>
          <p className="st-def-fs-cap t-mono">代码 · {size.code}px</p>
          <pre className="st-def-fs-pv-code t-code">
            <span>
              <i>1</i>
              {"const code = base * 0.875; // 比正文收一档"}
            </span>
            <span>
              <i>2</i>
              {"applyFontSize({ base });"}
            </span>
          </pre>
        </div>
      </section>

      {advanced &&
        TIERS.map(({ key, label, hint }) => (
          <SettingRow
            key={key}
            label={label}
            description={
              fs[key] === null
                ? `${hint}；跟随基准（当前 ${size[key]}px）`
                : `${hint}；已覆盖，不再随基准变化`
            }
          >
            <div className="st-def-fs-adv">
              <PxInput
                aria-label={label}
                min={OVERRIDE_MIN}
                max={OVERRIDE_MAX}
                value={size[key]}
                onChange={(v) => setOverride(key, v)}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${label}恢复跟随基准`}
                disabled={fs[key] === null}
                onClick={() => setOverride(key, null)}
              >
                恢复跟随
              </Button>
            </div>
          </SettingRow>
        ))}
    </section>
  );
}
