import { useCallback, useEffect, useState } from "react";
import {
  createVariable,
  deleteVariable,
  listVariables,
  loadToken,
  patchVariable,
  type Tier,
  type VariableInfo,
  type VariableScope,
} from "../api";
import { actionBtn, dangerBtn, describe, field, TIERS } from "./shared";

// 与 Server 的遮罩下限一致（ADR-0050）。
const MASK_MIN = 8;
const VALUE_MIN = 4;

const SCOPES: { id: VariableScope; label: string }[] = [
  { id: "any", label: "不限" },
  { id: "domain", label: "指定域名" },
  { id: "sudo", label: "仅 sudo 密码" },
];

const scopeText = (v: VariableInfo) =>
  v.scopeKind === "domain"
    ? `域名 ${v.scopeTarget}`
    : (SCOPES.find((s) => s.id === v.scopeKind)?.label ?? v.scopeKind);

const tierText = (t: Tier) => TIERS.find((x) => x.id === t)?.label ?? t;

interface Draft {
  name: string;
  purpose: string;
  value: string;
  scopeKind: VariableScope;
  scopeTarget: string;
  tier: Tier;
}

const EMPTY: Draft = {
  name: "",
  purpose: "",
  value: "",
  scopeKind: "any",
  scopeTarget: "",
  tier: "rules",
};

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

function VariableForm({
  editing,
  onDone,
  onCancel,
  onUnauthorized,
}: {
  editing: VariableInfo | null;
  onDone(): void;
  onCancel(): void;
  onUnauthorized(): void;
}) {
  const [f, setF] = useState<Draft>(
    editing
      ? {
          ...EMPTY,
          name: editing.name,
          purpose: editing.purpose,
          scopeKind: editing.scopeKind,
          scopeTarget: editing.scopeTarget ?? "",
          tier: editing.tier,
        }
      : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setF((cur) => ({ ...cur, [k]: v }));

  const target = f.scopeKind === "domain" ? f.scopeTarget.trim() : "";
  const valueOk = editing
    ? f.value === "" || f.value.length >= VALUE_MIN
    : f.value.length >= VALUE_MIN;
  const valid =
    f.name.trim() !== "" &&
    valueOk &&
    (f.scopeKind !== "domain" || target !== "");
  const short = f.value.length >= VALUE_MIN && f.value.length < MASK_MIN;

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: f.name.trim(),
      purpose: f.purpose.trim(),
      scopeKind: f.scopeKind,
      scopeTarget: target ? target.toLowerCase() : null,
      tier: f.tier,
    };
    const r = editing
      ? await patchVariable(loadToken(), editing.id, {
          ...body,
          ...(f.value ? { value: f.value } : {}),
        })
      : await createVariable(loadToken(), { ...body, value: f.value });
    setBusy(false);
    if (!r.ok) {
      if (r.kind === "unauthorized") onUnauthorized();
      return setError(
        describe(r, {
          bad_request:
            "请检查变量名（字母开头，字母数字下划线）、值（至少 4 个字符）与域名",
          conflict: "变量名已存在",
        }),
      );
    }
    setF(EMPTY);
    onDone();
  };

  return (
    <form
      aria-label={editing ? `编辑 @${editing.name}` : "登记变量"}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save();
      }}
      className="flex max-w-[640px] flex-col gap-3 border border-line p-4"
    >
      <h2 className="m-0 text-base font-bold">
        {editing ? `编辑 @${editing.name}` : "登记变量"}
      </h2>
      <Field label="变量名（命令里写成 @变量名）" id="v-name">
        <input
          id="v-name"
          value={f.name}
          autoComplete="off"
          onChange={(e) => set("name", e.target.value)}
          className={field}
        />
      </Field>
      <Field label="用途说明（模型可见，用来判断何时使用）" id="v-purpose">
        <input
          id="v-purpose"
          value={f.purpose}
          onChange={(e) => set("purpose", e.target.value)}
          className={field}
        />
      </Field>
      <Field
        label={
          editing
            ? "新值（留空则保留原值，只写入不回显）"
            : "值（只写入，之后不再显示）"
        }
        id="v-value"
      >
        <input
          id="v-value"
          type="password"
          autoComplete="new-password"
          value={f.value}
          onChange={(e) => set("value", e.target.value)}
          className={field}
        />
      </Field>
      {short && (
        <p role="note" className="m-0 text-xs text-acc">
          此值过短（少于 {MASK_MIN} 个字符），输出里的回显不会被遮罩。
        </p>
      )}
      <Field label="适用范围" id="v-scope">
        <select
          id="v-scope"
          value={f.scopeKind}
          onChange={(e) => set("scopeKind", e.target.value as VariableScope)}
          className={field}
        >
          {SCOPES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {f.scopeKind === "domain" && (
        <Field label="域名（含其子域名）" id="v-domain">
          <input
            id="v-domain"
            value={f.scopeTarget}
            placeholder="gitlab.example.com"
            onChange={(e) => set("scopeTarget", e.target.value)}
            className={field}
          />
        </Field>
      )}
      <Field label="授权档位" id="v-tier">
        <select
          id="v-tier"
          value={f.tier}
          onChange={(e) => set("tier", e.target.value as Tier)}
          className={field}
        >
          {TIERS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="m-0 text-xs text-mute">
        命令用到变量时，按工作区与变量中较严的一档审批；超出适用范围的用法一律人工确认。
      </p>
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={busy || !valid} className={actionBtn}>
          保存
        </button>
        {editing && (
          <button type="button" onClick={onCancel} className={actionBtn}>
            取消编辑
          </button>
        )}
      </div>
    </form>
  );
}

export function VariablesPanel({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [vars, setVars] = useState<VariableInfo[] | "loading" | "failed">(
    "loading",
  );
  const [editing, setEditing] = useState<VariableInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await listVariables(loadToken());
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    setVars(r.ok ? r.data : "failed");
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (v: VariableInfo) => {
    setError(null);
    const r = await deleteVariable(loadToken(), v.id);
    if (!r.ok) {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r));
    }
    if (editing?.id === v.id) setEditing(null);
    await reload();
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 max-w-[640px] text-sm text-mute">
        命令里写 @变量名，由 Server
        在执行时换成真值；真值不进入模型上下文，输出里出现的回显会被换回
        @变量名。值只能写入，不能再查看。
      </p>
      {vars === "loading" && <p className="text-mute">加载中…</p>}
      {vars === "failed" && (
        <p role="alert" className="font-semibold text-acc">
          变量列表加载失败
        </p>
      )}
      {Array.isArray(vars) && vars.length === 0 && (
        <p className="m-0 text-mute">还没有登记变量。</p>
      )}
      {Array.isArray(vars) && vars.length > 0 && (
        <ul className="m-0 flex max-w-[640px] list-none flex-col gap-2 p-0">
          {vars.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-3 border border-line px-3 py-2"
            >
              <div className="min-w-0">
                <div className="font-mono font-semibold">@{v.name}</div>
                <div className="truncate text-xs text-mute">
                  {v.purpose || "无用途说明"} · {scopeText(v)} ·{" "}
                  {tierText(v.tier)}
                </div>
                {!v.maskable && (
                  <div className="text-xs text-acc">
                    值过短，输出回显不会被遮罩
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  aria-label={`编辑 @${v.name}`}
                  className={actionBtn}
                  onClick={() => setEditing(v)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`删除 @${v.name}`}
                  className={dangerBtn}
                  onClick={() => void remove(v)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <VariableForm
        key={editing?.id ?? "new"}
        editing={editing}
        onDone={() => {
          setEditing(null);
          void reload();
        }}
        onCancel={() => setEditing(null)}
        onUnauthorized={onUnauthorized}
      />
    </div>
  );
}
