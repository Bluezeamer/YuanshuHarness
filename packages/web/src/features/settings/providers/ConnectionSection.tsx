import { useEffect, useRef, useState } from "react";
import {
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderView,
} from "../../../api/providers";
import { Button, Dot, Input, Segmented, Select, SettingRow } from "../../../ui";
import { act } from "./actions";
import { CredentialSource } from "./CredentialSource";
import { type Editable, type EditErrors, withPrimary } from "./edit";
import { LoginDialog } from "./LoginDialog";
import {
  API_LABEL,
  API_PLACEHOLDER,
  isProviderApi,
  loggedIn,
  PRIMARY_LABEL,
  primariesOf,
  primaryOf,
} from "./model";
import type { ProvidersStore } from "./store";

export interface SectionProps {
  p: ProviderView;
  store: ProvidersStore;
  draft: Editable;
  errors: EditErrors;
  onChange: (patch: Partial<Editable>) => void;
}

// 订阅登录：只有登没登录两种状态，登录与退出是动作（立即执行），登录走弹窗。
function SubscriptionRow({
  p,
  store,
}: {
  p: ProviderView;
  store: ProvidersStore;
}) {
  const [login, setLogin] = useState(false);
  const on = loggedIn(p);
  return (
    <SettingRow
      label="订阅账号"
      description={`用你的 ${p.name} 订阅账号，不需要 API Key`}
    >
      <div className="pv-ctl pv-ctl-end">
        {on ? (
          <>
            <span className="pv-acct t-plain">
              <Dot tone="live" size="sm" />
              已登录
            </span>
            <Button
              variant="ghost"
              onClick={() => void act(store.logout(p.id), "已退出登录")}
            >
              退出登录
            </Button>
          </>
        ) : (
          <>
            <span className="t-aux">还没有登录</span>
            <Button variant="secondary" onClick={() => setLogin(true)}>
              登录
            </Button>
          </>
        )}
      </div>
      {login && (
        <LoginDialog
          id={p.id}
          name={p.name}
          onClose={() => setLogin(false)}
          onDone={() => {
            setLogin(false);
            void store.load();
          }}
        />
      )}
    </SettingRow>
  );
}

// API Key：已有就显示成一行「已保存」，要换才出输入框。键入的新密钥进草稿（null = 没在更换），点保存才写；
// 移除是动作。env / cmd 是只读的来源说明，改来源在「高级」里。
function KeyRow({
  p,
  store,
  draft,
  apiKey,
  onApiKey,
  onChange,
}: Omit<SectionProps, "errors"> & {
  apiKey: string | null;
  onApiKey: (v: string | null) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const replacing = apiKey !== null;
  useEffect(() => {
    if (replacing && p.hasKey) field.current?.focus();
  }, [replacing, p.hasKey]);

  if (draft.method === "env" || draft.method === "cmd") {
    const env = draft.method === "env";
    return (
      <SettingRow
        label="API Key"
        description={
          env
            ? "读取环境变量，元枢不保存"
            : "在 Server 主机上运行命令取得，元枢不保存"
        }
      >
        <div className="pv-ctl">
          <Input
            mono
            readOnly
            aria-label={env ? "环境变量" : "取密钥命令"}
            value={
              env
                ? draft.envVariable
                  ? `$${draft.envVariable}`
                  : "由 pi 内置的环境变量决定"
                : draft.command
            }
          />
          <Button variant="ghost" onClick={() => onChange({ method: "key" })}>
            改为直接填写
          </Button>
        </div>
      </SettingRow>
    );
  }

  const editing = !p.hasKey || replacing;
  return (
    <SettingRow
      label="API Key"
      description={
        editing
          ? p.custom
            ? "可以不填：本地端点常不需要密钥。保存后不再回显"
            : "保存后不再回显"
          : "已保存，不再回显"
      }
    >
      {(c) =>
        editing ? (
          <div className="pv-ctl">
            <Input
              {...c}
              ref={field}
              mono
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey ?? ""}
              placeholder={p.hasKey ? "输入新密钥以更换" : "粘贴密钥"}
              onChange={(e) => onApiKey(e.target.value)}
            />
            {p.hasKey && (
              <Button variant="ghost" onClick={() => onApiKey(null)}>
                取消
              </Button>
            )}
          </div>
        ) : (
          <div className="pv-ctl">
            <Input
              {...c}
              mono
              readOnly
              value="••••••••••••"
              aria-label="已保存的密钥"
            />
            <Button variant="ghost" onClick={() => onApiKey("")}>
              更换
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void act(
                  store.update(p.id, () => ({ apiKey: null })),
                  "已移除密钥",
                )
              }
            >
              移除
            </Button>
          </div>
        )
      }
    </SettingRow>
  );
}

export function ConnectionSection({
  p,
  store,
  draft,
  errors,
  onChange,
  apiKey,
  onApiKey,
}: SectionProps & {
  apiKey: string | null;
  onApiKey: (v: string | null) => void;
}) {
  const primaries = primariesOf(p);
  const primary = primaryOf(draft.method);

  return (
    <section className="st-block" aria-label="连接">
      <header className="st-block-h t-group">连接</header>

      {primaries.length > 1 && (
        <SettingRow
          label="登录方式"
          description={
            primary === "oauth"
              ? "走订阅额度，不按量计费"
              : primary === "ambient"
                ? "凭据取自 Server 主机的环境（AWS / GCP）"
                : "按量计费的 API Key"
          }
        >
          <Segmented
            aria-label="登录方式"
            value={primary}
            onChange={(to) =>
              onChange({ method: withPrimary(draft, p, to).method })
            }
            options={primaries.map((m) => ({
              value: m,
              label: PRIMARY_LABEL[m],
            }))}
          />
        </SettingRow>
      )}

      {primary === "oauth" && <SubscriptionRow p={p} store={store} />}
      {primary === "ambient" && (
        <p className="pv-note t-aux">
          云凭据取自 Server 主机的环境，WebUI 不读取也不保存。
        </p>
      )}
      {primary === "key" && (
        <KeyRow
          p={p}
          store={store}
          draft={draft}
          apiKey={apiKey}
          onApiKey={onApiKey}
          onChange={onChange}
        />
      )}

      {p.custom && (
        <>
          <SettingRow
            label="名称"
            description="用于会话与审计"
            error={errors.name}
          >
            {(c) => (
              <Input
                {...c}
                aria-label="名称"
                value={draft.name}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            )}
          </SettingRow>
          <SettingRow label="请求协议" description="决定请求与流式事件的结构">
            {(c) => (
              <Select
                {...c}
                value={draft.api}
                options={PROVIDER_APIS.map((a) => ({
                  value: a,
                  label: API_LABEL[a],
                }))}
                onChange={(v) => onChange({ api: v as ProviderApi })}
              />
            )}
          </SettingRow>
        </>
      )}

      <SettingRow
        label="地址"
        description={
          p.custom
            ? "协议 + 主机 + 版本路径，不含 /chat/completions"
            : "可覆盖内置端点（区域端点、代理）；清空即恢复默认"
        }
      >
        {(c) => (
          <div className="pv-ctl">
            <Input
              {...c}
              mono
              aria-label="Base URL"
              placeholder={
                p.custom
                  ? isProviderApi(draft.api)
                    ? API_PLACEHOLDER[draft.api]
                    : ""
                  : "内置端点 · 由 pi 管理"
              }
              value={draft.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
            />
            {!p.custom && (
              <Button
                variant="ghost"
                disabled={draft.baseUrl === ""}
                onClick={() => onChange({ baseUrl: "" })}
              >
                恢复默认
              </Button>
            )}
          </div>
        )}
      </SettingRow>

      <CredentialSource p={p} />
    </section>
  );
}
