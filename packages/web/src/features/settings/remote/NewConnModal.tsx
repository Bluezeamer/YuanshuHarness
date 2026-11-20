import { useState } from "react";
import type { ConnectionView, Credential } from "../../../api/connections";
import {
  Button,
  Field,
  FormDialog,
  Input,
  Segmented,
  Select,
} from "../../../ui";
import {
  EMPTY_FORM,
  type FormErrors,
  jumpChoices,
  type NewForm,
  validateForm,
} from "./model";
import type { RemoteStore } from "./store";

const AUTH_OPTIONS = [
  { value: "key", label: "私钥" },
  { value: "password", label: "密码" },
] as const;

// 服务端的校验码落到对应字段，其余落到表单底部。
const FIELD_OF: Record<string, keyof FormErrors> = {
  invalid_label: "label",
  name_exists: "label",
  invalid_host: "host",
  invalid_port: "port",
  invalid_user: "user",
  invalid_auth: "auth",
  auth_kind_mismatch: "auth",
  jump_not_found: "jump",
  jump_cycle: "jump",
  jump_too_deep: "jump",
};

function Form({
  conns,
  keys,
  store,
  onClose,
  onCreated,
}: {
  conns: readonly ConnectionView[];
  keys: readonly Credential[];
  store: RemoteStore;
  onClose: () => void;
  onCreated: (id: string, activate: boolean) => void;
}) {
  const [f, setF] = useState<NewForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sshKeys = keys.filter((k) => k.kind === "ssh_key");
  const choices = jumpChoices(null, conns);
  const set = <K extends keyof NewForm>(k: K, v: NewForm[K]) =>
    setF((cur) => ({ ...cur, [k]: v }));

  const submit = async (activate: boolean) => {
    const next = validateForm(f, conns);
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    const r = await store.create(f);
    setBusy(false);
    if (r.ok) return onCreated(r.data.id, activate);
    const field = r.code ? FIELD_OF[r.code] : undefined;
    if (field) setErrors({ [field]: r.message });
    else setFormError(r.message);
  };

  const ready =
    f.label.trim() !== "" &&
    f.host.trim() !== "" &&
    f.user.trim() !== "" &&
    (f.authKind === "key" ? f.keyId !== "" : f.password !== "");

  return (
    <FormDialog
      open
      onClose={onClose}
      title="新建连接"
      description="连接是执行环境，不是目录——目录是环境里的目录。"
      confirmLabel="创建并激活"
      canSubmit={ready}
      busy={busy}
      error={formError}
      onSubmit={() => void submit(true)}
      aside={
        <Button
          variant="ghost"
          size="lg"
          disabled={!ready || busy}
          onClick={() => void submit(false)}
        >
          仅创建
        </Button>
      }
    >
      <Field label="名称" error={errors.label}>
        {(ctl) => (
          <Input
            {...ctl}
            autoComplete="off"
            placeholder="例如 GPU 训练机"
            value={f.label}
            onChange={(e) => set("label", e.target.value)}
          />
        )}
      </Field>
      <Field label="主机" hint="主机名或 IP" error={errors.host}>
        {(ctl) => (
          <Input
            {...ctl}
            mono
            autoComplete="off"
            spellCheck={false}
            value={f.host}
            onChange={(e) => set("host", e.target.value)}
          />
        )}
      </Field>
      <div className="st-rc-pair">
        <Field label="端口" error={errors.port}>
          {(ctl) => (
            <Input
              {...ctl}
              mono
              inputMode="numeric"
              value={f.port}
              onChange={(e) => set("port", e.target.value)}
            />
          )}
        </Field>
        <Field label="登录用户" error={errors.user}>
          {(ctl) => (
            <Input
              {...ctl}
              mono
              autoComplete="off"
              spellCheck={false}
              value={f.user}
              onChange={(e) => set("user", e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="认证方式">
        <Segmented
          aria-label="认证方式"
          options={AUTH_OPTIONS}
          value={f.authKind}
          onChange={(v) => set("authKind", v)}
        />
      </Field>
      {f.authKind === "key" ? (
        <Field
          label="私钥"
          hint={
            sshKeys.length === 0
              ? "密钥库是空的，先到「密钥」页签导入一把私钥"
              : "私钥由服务端加密持有，不出服务端"
          }
          error={errors.auth}
        >
          {(ctl) => (
            <Select
              {...ctl}
              value={f.keyId}
              options={[
                { value: "", label: "选择一把私钥…" },
                ...sshKeys.map((k) => ({ value: k.id, label: k.name })),
              ]}
              onChange={(v) => set("keyId", v)}
            />
          )}
        </Field>
      ) : (
        <Field
          label="密码"
          hint="保存到服务端并加密，不会再回显"
          error={errors.auth}
        >
          {(ctl) => (
            <Input
              {...ctl}
              type="password"
              autoComplete="new-password"
              value={f.password}
              onChange={(e) => set("password", e.target.value)}
            />
          )}
        </Field>
      )}
      <Field label="跳板机" hint="至多一台；链深最多 4 跳" error={errors.jump}>
        {(ctl) => (
          <Select
            {...ctl}
            value={f.jumpId}
            options={[
              { value: "", label: "直连" },
              ...choices.map(({ conn, reason }) => ({
                value: conn.id,
                label: `${conn.label} · ${conn.host}${reason ? `（${reason}）` : ""}`,
                disabled: reason !== null,
              })),
            ]}
            onChange={(v) => set("jumpId", v)}
          />
        )}
      </Field>
    </FormDialog>
  );
}

/** 关闭时整体卸载，下次打开是干净的表单。 */
export function NewConnModal({
  open,
  ...rest
}: { open: boolean } & React.ComponentProps<typeof Form>) {
  return open ? <Form {...rest} /> : null;
}
