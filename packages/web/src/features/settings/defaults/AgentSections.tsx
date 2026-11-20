import { useState } from "react";
import type { AgentSettingsView } from "../../../api/agentSettings";
import {
  Button,
  InlineNotice,
  Segmented,
  SettingRow,
  Switch,
} from "../../../ui";
import {
  PRESET_HINT,
  PRESET_LABEL,
  type Preset,
  presetFields,
  presetOf,
} from "./agent";
import { NumRow, type TabProps } from "./fields";

const PRESETS: readonly Preset[] = ["default", "lean", "detail"];
const NUMBERS = ["compactReserve", "compactKeep"] as const;

/** 上下文压缩：两档预设管互相牵连的两个数，要细调再展开。 */
export function CompactionSection(p: TabProps & { agent: AgentSettingsView }) {
  const { form, set, errors, agent } = p;
  const [more, setMore] = useState(false);
  // 数字有填错的项时不能收起，免得错误藏在看不见的地方
  const open = more || NUMBERS.some((k) => errors[k]);
  const preset = presetOf(form, agent.defaults);
  return (
    <section className="st-block" aria-label="上下文压缩">
      <header className="st-block-h t-group">
        <span>上下文压缩</span>
        <span className="st-def-grow" />
        {form.compactOn && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            onClick={() => setMore(!open)}
          >
            {open ? "收起数字" : "调整数字"}
          </Button>
        )}
      </header>
      {agent.problems.length > 0 && (
        <InlineNotice tone="warn">
          {agent.file} 里有被忽略的项：{agent.problems.join("；")}
        </InlineNotice>
      )}
      <SettingRow
        label="自动压缩上下文"
        description={
          form.compactOn
            ? "上下文快满时，自动把较早的对话压成摘要，较新的原样保留"
            : "关闭后上下文满了会直接报错，只能用 /compact 手动压缩"
        }
      >
        <Switch
          aria-label="自动压缩上下文"
          checked={form.compactOn}
          onChange={(compactOn) => set({ compactOn })}
        />
      </SettingRow>
      {form.compactOn && (
        <SettingRow
          label="压缩方式"
          description={
            preset
              ? `${PRESET_HINT[preset]}（预留 ${form.compactReserve.trim()}，保留最近 ${form.compactKeep.trim()}）`
              : "当前是自定义的数字，选一档会覆盖它们"
          }
        >
          <Segmented<Preset | "custom">
            aria-label="压缩方式"
            options={[
              ...PRESETS.map((v) => ({ value: v, label: PRESET_LABEL[v] })),
              ...(preset
                ? []
                : [{ value: "custom" as const, label: "自定义" }]),
            ]}
            value={preset ?? "custom"}
            onChange={(v) =>
              v !== "custom" && set(presetFields(v, agent.defaults))
            }
          />
        </SettingRow>
      )}
      {form.compactOn && open && (
        <>
          <NumRow
            {...p}
            field="compactReserve"
            label="预留余量"
            description="token。触发线 = 模型窗口 − 这个值，也是给回复与摘要留的空间；越大压得越早"
          />
          <NumRow
            {...p}
            field="compactKeep"
            label="保留最近"
            description="token。压缩时原样保留的最近内容，其余压成摘要；必须小于触发线，否则压不动"
          />
        </>
      )}
    </section>
  );
}

/** 请求重试：模型请求遇到网络抖动、限流、服务端 5xx 时自动再试。 */
export function RetrySection(p: TabProps) {
  const { form, set } = p;
  return (
    <section className="st-block" aria-label="请求重试">
      <header className="st-block-h t-group">请求重试</header>
      <SettingRow
        label="自动重试"
        description="模型请求遇到网络抖动、限流或服务端错误时，隔一会儿自动再试，不打断对话"
      >
        <Switch
          aria-label="自动重试"
          checked={form.retryOn}
          onChange={(retryOn) => set({ retryOn })}
        />
      </SettingRow>
      {form.retryOn && (
        <NumRow
          {...p}
          field="retryMax"
          label="重试次数"
          description="最多再试几次，用完仍失败就报错；0 等于不重试"
        />
      )}
    </section>
  );
}
