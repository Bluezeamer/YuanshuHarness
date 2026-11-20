import type { AgentSettingsView } from "../../../api/agentSettings";
import { Input, SettingRow, Switch } from "../../../ui";
import { CompactionSection, RetrySection } from "./AgentSections";
import { NumRow, type TabProps } from "./fields";

/** 会话与任务：后台任务提醒、目标续跑、上下文压缩与重试、子代理限额、选目录的起点。 */
export function SessionTab(p: TabProps & { agent: AgentSettingsView }) {
  const { form, set, errors } = p;
  return (
    <>
      <section className="st-block" aria-label="后台任务">
        <header className="st-block-h t-group">后台任务</header>
        <NumRow
          {...p}
          field="remindMin"
          label="提醒间隔"
          description="分钟。命令、工具或子代理在后台跑时每隔这么久提醒 agent 一次，不会因此停掉任务；阻塞的命令跑到这个时间也会转成后台任务"
        />
      </section>

      <section className="st-block" aria-label="目标">
        <header className="st-block-h t-group">目标</header>
        <SettingRow
          label="限制续跑轮数"
          description={
            form.goalUnlimited
              ? "不限制：只要模型没宣布完成或受阻，agent 就一直续跑，直到你暂停或停止"
              : "agent 交付后会被再次唤醒继续做，达到轮数就收尾并停下，点「继续」重新计数"
          }
        >
          <Switch
            aria-label="限制续跑轮数"
            checked={!form.goalUnlimited}
            onChange={(on) => set({ goalUnlimited: !on })}
          />
        </SettingRow>
        {!form.goalUnlimited && (
          <NumRow
            {...p}
            field="goalRounds"
            label="轮数上限"
            description="新建的目标取这个值（模型自己设的目标也一样），之后可在右栏的目标上单独改"
          />
        )}
      </section>

      <CompactionSection {...p} />
      <RetrySection {...p} />

      <section className="st-block" aria-label="子代理限额">
        <header className="st-block-h t-group">子代理限额</header>
        <p className="st-def-note t-aux">
          只数存活的子代理：交付即释放名额，超限直接报错、不排队。模型并发请求数是另一回事，在供应商设置里。
        </p>
        <NumRow
          {...p}
          field="maxDepth"
          label="最大深度"
          description="子代理再派发子代理的层数上限，根会话算 0 层"
        />
        <NumRow
          {...p}
          field="perCaller"
          label="每个调用方同时存活"
          description="一个会话同时存活（没交付也没被停止）的子代理数"
        />
        <NumRow
          {...p}
          field="perTree"
          label="整棵树同时存活"
          description="从根会话往下所有层加起来同时存活的子代理数"
        />
      </section>

      <section className="st-block" aria-label="目录选择">
        <header className="st-block-h t-group">目录选择</header>
        <SettingRow
          label="起点路径"
          description="选目录时输入框里还没有路径，就从这里开始浏览；本机与远程主机同一个值。~ 展开为各主机自己的家目录"
          error={errors.start}
        >
          {(c) => (
            <Input
              {...c}
              mono
              placeholder="~"
              value={form.start}
              onChange={(e) => set({ start: e.target.value })}
              onBlur={() => set({ start: form.start.trim() })}
            />
          )}
        </SettingRow>
      </section>
    </>
  );
}
