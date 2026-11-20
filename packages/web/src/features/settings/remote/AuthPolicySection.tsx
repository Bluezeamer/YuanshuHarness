import type { ConnectionView, Credential } from "../../../api/connections";
import { Input, Segmented, Select, SettingRow, Switch } from "../../../ui";
import type { Editable, EditErrors } from "./model";

const AUTH_OPTIONS = [
  { value: "key", label: "私钥" },
  { value: "password", label: "密码" },
] as const;

const HOSTKEY_OPTIONS = [
  { value: "ask", label: "询问" },
  { value: "tofu", label: "自动记录" },
] as const;

export function AuthSection({
  c,
  keys,
  draft,
  password,
  errors,
  onChange,
  onPassword,
}: {
  c: ConnectionView;
  keys: readonly Credential[];
  draft: Editable;
  password: string;
  errors: EditErrors;
  onChange: (patch: Partial<Editable>) => void;
  onPassword: (v: string) => void;
}) {
  const sshKeys = keys.filter((k) => k.kind === "ssh_key");
  const current = sshKeys.find((k) => k.id === draft.keyId);

  return (
    <section className="st-block" aria-label="认证">
      <header className="st-block-h t-group">认证</header>
      <p className="st-rc-note t-aux">
        认证只有私钥和密码两种。凭据由服务端加密持有，不会回显，私钥不出服务端。
      </p>
      <SettingRow label="方式">
        <Segmented
          aria-label="认证方式"
          options={AUTH_OPTIONS}
          value={draft.authKind}
          onChange={(authKind) => {
            if (authKind === "key") onPassword("");
            onChange({ authKind });
          }}
        />
      </SettingRow>
      {draft.authKind === "key" ? (
        <SettingRow label="私钥" error={errors.auth}>
          <div className="st-rc-stack">
            <Select
              aria-label="私钥"
              value={draft.keyId}
              options={[
                ...(draft.keyId === ""
                  ? [{ value: "", label: "选择一把私钥…" }]
                  : []),
                ...sshKeys.map((k) => ({ value: k.id, label: k.name })),
              ]}
              onChange={(keyId) => onChange({ keyId })}
            />
            {current?.fingerprint && (
              <span className="st-rc-fp-inline t-mono">
                {current.keyType} · {current.fingerprint}
              </span>
            )}
            {sshKeys.length === 0 && (
              <span className="st-rc-hint t-aux">
                密钥库是空的，先到「密钥」页签导入一把私钥。
              </span>
            )}
          </div>
        </SettingRow>
      ) : (
        <SettingRow
          label="密码"
          description={
            c.auth.kind === "password" ? "已保存 · 不回显" : "尚未保存密码"
          }
          error={errors.auth}
        >
          <Input
            type="password"
            autoComplete="new-password"
            aria-label="登录密码"
            placeholder={
              c.auth.kind === "password" ? "输入新密码以替换" : "登录密码"
            }
            value={password}
            onChange={(e) => onPassword(e.target.value)}
          />
        </SettingRow>
      )}
    </section>
  );
}

export function PolicySection({
  draft,
  onChange,
}: {
  draft: Editable;
  onChange: (patch: Partial<Editable>) => void;
}) {
  return (
    <section className="st-block" aria-label="连接策略">
      <header className="st-block-h t-group">连接策略</header>
      <p className="st-rc-note t-aux">
        变更永不自动信任：即使把首次连接设为「自动记录」，主机密钥变了仍会阻断。
      </p>
      <SettingRow label="首次连接" description="主机密钥策略">
        <Segmented
          aria-label="首次连接的主机密钥策略"
          options={HOSTKEY_OPTIONS}
          value={draft.hostKey}
          onChange={(hostKey) => onChange({ hostKey })}
        />
      </SettingRow>
      <SettingRow label="保持连接" description="定时发送心跳，防止空闲断线">
        <Switch
          aria-label="保持连接"
          checked={draft.keepAlive}
          onChange={(keepAlive) => onChange({ keepAlive })}
        />
      </SettingRow>
    </section>
  );
}
