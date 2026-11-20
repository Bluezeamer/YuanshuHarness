import { useState } from "react";
import type { McpView } from "../../../../api/mcpLibrary";
import type { Policy } from "../../../../api/toolRules";
import {
  Button,
  Chip,
  InlineNotice,
  Menu,
  type MenuItem,
  Segmented,
  SettingRow,
  Switch,
} from "../../../../ui";
import { ToolsIcon } from "../../../../ui/icons";
import { DetailHead } from "../../frame/DetailHead";
import { FormColumn } from "../../frame/layout";
import { useBindDirty } from "../../frame/leave";
import { notify } from "../../frame/notify";
import { SaveBar } from "../../frame/SaveBar";
import { useDraft } from "../../frame/useDraft";
import { relTime } from "../common/format";
import { EnvRow } from "../common/parts";
import { check, toggleEnabled } from "./actions";
import { CheckSteps } from "./CheckSteps";
import {
  confJson,
  fullName,
  hasOauth,
  isAuthFailure,
  isUpdatable,
  NO_DESCRIPTION,
  statusOf,
  targetOf,
  toolCount,
  versionText,
} from "./model";
import type { McpReady, McpStore } from "./store";

const APPROVAL = [
  { value: "allow", label: "放行" },
  { value: "ask", label: "审批" },
] as const;

// 工具清单只列前几个，全部在「详情」弹窗里
const SHOWN = 6;

export interface McpDetailProps {
  server: McpView;
  store: McpStore;
  state: McpReady;
  onEdit: () => void;
  onInfo: () => void;
  onPin: () => void;
  onVersions: () => void;
  onRemove: () => void;
}

/**
 * MCP 服务详情。父级用 key={name} 挂载，切换服务时草稿自然重置。
 * 检测、启用、固定是立即动作；审批档进草稿，点保存才落（ys-ui-design 的 X06）。
 */
export function McpDetail({
  server: m,
  store,
  state,
  onEdit,
  onInfo,
  onPin,
  onVersions,
  onRemove,
}: McpDetailProps) {
  const d = useDraft<{ approval: Policy; global: boolean }>(
    { approval: m.approval, global: m.global },
    async (draft) => {
      const r = await store.setSettings(m.name, draft);
      return r.ok ? null : r.message;
    },
  );
  useBindDirty({ dirty: d.dirty, save: d.save, discard: d.discard });

  const [checking, setChecking] = useState(false);
  const busy = state.busy[m.name];
  const st = statusOf(m, busy ?? null);
  const last = state.checks[m.name];
  const pinnable = m.source !== null;
  const total = toolCount(m);
  const shown = (m.tools ?? []).slice(0, SHOWN);
  const failed = m.enabled && m.handshake?.ok === false;
  const real = m.description !== NO_DESCRIPTION;

  const runCheck = async () => {
    setChecking(true);
    const problem = await check(store, m.name);
    setChecking(false);
    notify(problem, "检测通过");
  };

  const menu: MenuItem[] = [
    { id: "edit", label: "编辑配置", onSelect: onEdit },
    ...(pinnable
      ? [
          {
            id: "pin",
            label: m.pinned ? "重新固定" : "试装并固定",
            disabled: !m.enabled,
            onSelect: onPin,
          },
          {
            id: "versions",
            label: "选择版本",
            disabled: !m.enabled,
            onSelect: onVersions,
          },
        ]
      : []),
    ...(m.enabled
      ? [
          {
            id: "disable",
            label: "禁用",
            separatorBefore: true,
            onSelect: () => void toggleEnabled(store, m),
          },
        ]
      : []),
    {
      id: "remove",
      label: "卸载",
      tone: "danger",
      separatorBefore: !m.enabled,
      onSelect: onRemove,
    },
  ];

  const localState = !m.enabled
    ? "已禁用，未连接"
    : m.handshake?.ok === true
      ? `${st.text} · 握手 ${m.handshake.ms}ms · ${relTime(m.handshake.at)}`
      : st.text;

  return (
    <>
      <FormColumn>
        <article aria-label={`${m.name} 详情`}>
          <DetailHead
            icon={<ToolsIcon size={18} />}
            title={m.name}
            sub={
              real ? (
                m.description
              ) : (
                <span className="t-mono">{targetOf(m)}</span>
              )
            }
            status={{ text: st.text, tone: st.tone ?? "idle" }}
            actions={
              <>
                {m.enabled ? (
                  <Button
                    variant={st.key === "ok" ? "outline" : "primary"}
                    loading={checking || st.key === "busy"}
                    onClick={() => void runCheck()}
                  >
                    检测
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => void toggleEnabled(store, m)}
                  >
                    启用
                  </Button>
                )}
                <Menu label="更多操作" items={menu} />
              </>
            }
          />

          {failed && (
            <InlineNotice tone="danger" className="tp-err">
              {m.handshake?.error ?? "握手失败"}
              {isAuthFailure(m) && "。到「编辑配置」里换掉密钥引用后重新检测。"}
            </InlineNotice>
          )}

          <section className="st-block" aria-label="生效范围">
            <header className="st-block-h t-group">生效范围</header>
            <SettingRow
              label="对所有会话生效"
              description={
                d.draft.global
                  ? "每个会话都会在所在主机上带起它，不用再勾选。"
                  : "只在勾选了它的工作区里生效（工作区设置 · 技能与 MCP）。"
              }
            >
              <Switch
                aria-label={`${m.name} 全局`}
                checked={d.draft.global}
                onChange={(global) => d.setDraft({ ...d.draft, global })}
              />
            </SettingRow>
          </section>

          <section className="st-block" aria-label="运行位置">
            <header className="st-block-h t-group">运行位置</header>
            <p className="tp-note t-aux">
              {m.transport === "http"
                ? "http 服务由 Server 直接连接，与目录所在的环境无关。"
                : "会话里的 stdio 进程起在会话第一个目录所在的主机（远程目录经 SSH 在那台主机上起），创建后固定，每个会话各起一份。下面的检测与试装只在 Server 本机跑。"}
            </p>
            {m.transport === "stdio" && (
              <p className="tp-note t-aux">
                当前版本对每台远程主机同时最多支持 10 个 MCP 连接（SSH
                通道上限，运行中的命令也占用）。
              </p>
            )}
            <ul className="tp-envs" aria-label="运行情况">
              <EnvRow
                host={m.transport === "http" ? "Server 直连" : "本机（Server）"}
                tone={st.tone ?? "idle"}
                state={localState}
              />
            </ul>
            {last && <CheckSteps steps={last.steps} />}
          </section>

          <section className="st-block" aria-label="审批">
            <header className="st-block-h t-group">审批</header>
            <SettingRow
              label="调用审批"
              description={
                total > 0
                  ? `对 ${total} 个 mcp__${m.name}__* 工具统一生效，不分 cwd 内外`
                  : "握手后对新工具生效，不分 cwd 内外"
              }
            >
              <Segmented
                aria-label={`${m.name} 审批`}
                options={APPROVAL}
                value={d.draft.approval}
                onChange={(approval) => d.setDraft({ ...d.draft, approval })}
              />
            </SettingRow>
          </section>

          <section className="st-block" aria-label="工具">
            <header className="st-block-h t-group">
              <span>工具</span>
              <span className="t-mono">{total}</span>
              <span className="tp-grow" />
              {total > shown.length && (
                <Button size="sm" variant="ghost" onClick={onInfo}>
                  查看全部
                </Button>
              )}
            </header>
            {shown.length > 0 ? (
              <ul className="tp-files">
                {shown.map((t) => (
                  <li key={t.name} className="t-mono">
                    {fullName(m.name, t.name)}
                  </li>
                ))}
                {total > shown.length && (
                  <li className="t-aux">另 {total - shown.length} 个未列出</li>
                )}
              </ul>
            ) : (
              <p className="tp-note t-aux">
                {m.enabled ? "握手后才有工具" : "已禁用，未连接"}
              </p>
            )}
          </section>

          {pinnable && (
            <section className="st-block" aria-label="版本">
              <header className="st-block-h t-group">版本</header>
              <SettingRow
                label="当前"
                description={
                  m.pinned
                    ? "固定在 args 里的版本，不会自己跟新"
                    : "每次启动解析最新版；固定后才可复现"
                }
              >
                <span className="tp-inline">
                  <span className="t-mono">{versionText(m)}</span>
                  {isUpdatable(m) && <Chip>最新 {m.latestVersion}</Chip>}
                </span>
              </SettingRow>
            </section>
          )}

          <section className="st-block" aria-label="配置">
            <header className="st-block-h t-group">
              <span>配置</span>
              <span className="t-mono">mcpServers</span>
              <span className="tp-grow" />
              <Button size="sm" variant="ghost" onClick={onEdit}>
                编辑配置
              </Button>
            </header>
            <pre className="tp-json t-mono" data-testid={`conf-${m.name}`}>
              {confJson(m)}
            </pre>
            {hasOauth(m) && (
              <p className="tp-note t-aux">
                oauth 已登记，Server 目前不执行授权流程。
              </p>
            )}
          </section>
        </article>
      </FormColumn>
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
    </>
  );
}
