import { useCallback, useEffect, useState } from "react";
import {
  type CallResult,
  createModel,
  deleteModel,
  listModels,
  loadToken,
  type ModelApiKind,
  type ModelCompat,
  type ModelInfo,
  type ModelInput,
  setDefaultModel,
  type ThinkingLevel,
  type ThinkingLevelMap,
  testModel,
} from "../api";
import { actionBtn, dangerBtn, describe, field } from "./shared";

const APIS: { id: ModelApiKind; label: string }[] = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
];

const LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// 三态：不设置（用 pi 默认）/ 是 / 否。
const TRI_COMPAT: { key: keyof ModelCompat & string; label: string }[] = [
  { key: "supportsDeveloperRole", label: "支持 developer 角色" },
  { key: "supportsMidConvoSystemMessages", label: "支持中途 system 消息" },
  { key: "supportsMidConvoToolAdditions", label: "支持中途追加工具" },
  { key: "supportsStrictMode", label: "支持 strict 工具模式" },
];

type Tri = "" | "true" | "false";
type LevelCell = { mode: "default" | "unsupported" | "map"; value: string };

const EMPTY = {
  name: "",
  api: "openai-completions" as ModelApiKind,
  baseUrl: "",
  modelId: "",
  contextWindow: "",
  maxTokens: "",
  apiKey: "",
  reasoning: false,
  image: false,
  maxTokensField: "" as "" | "max_completion_tokens" | "max_tokens",
  tri: {} as Record<string, Tri>,
  levels: {} as Partial<Record<ThinkingLevel, LevelCell>>,
};

const positive = (v: string) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : undefined;
};

function buildCompat(f: typeof EMPTY): ModelCompat | undefined {
  const out: Record<string, unknown> = {};
  for (const { key } of TRI_COMPAT)
    if (f.tri[key]) out[key] = f.tri[key] === "true";
  if (f.maxTokensField) out.maxTokensField = f.maxTokensField;
  return Object.keys(out).length ? (out as ModelCompat) : undefined;
}

function buildLevelMap(f: typeof EMPTY): ThinkingLevelMap | undefined {
  const out: ThinkingLevelMap = {};
  for (const lv of LEVELS) {
    const c = f.levels[lv];
    if (c?.mode === "unsupported") out[lv] = null;
    else if (c?.mode === "map" && c.value.trim()) out[lv] = c.value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function AddForm({
  onAdded,
  onUnauthorized,
}: {
  onAdded(): void;
  onUnauthorized(): void;
}) {
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) =>
    setF((cur) => ({ ...cur, [k]: v }));
  const input = (): ModelInput => {
    const contextWindow = positive(f.contextWindow);
    const maxTokens = positive(f.maxTokens);
    const compat = buildCompat(f);
    const thinkingLevelMap = buildLevelMap(f);
    return {
      name: f.name.trim(),
      api: f.api,
      baseUrl: f.baseUrl.trim(),
      modelId: f.modelId.trim(),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      reasoning: f.reasoning,
      input: f.image ? ["text", "image"] : ["text"],
      ...(compat ? { compat } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(f.apiKey ? { apiKey: f.apiKey } : {}),
    };
  };
  const valid = f.name.trim() && f.baseUrl.trim() && f.modelId.trim();
  const bad = {
    bad_request: "请检查名称、地址（须以 http(s):// 开头）与上下文窗口",
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    const r = await testModel(loadToken(), input());
    setBusy(false);
    if (!r.ok) {
      if (r.kind === "unauthorized") onUnauthorized();
      return setMsg({ ok: false, text: describe(r, bad) });
    }
    setMsg(
      r.data.ok
        ? { ok: true, text: "连接成功" }
        : { ok: false, text: `连接失败：${r.data.error ?? "未知原因"}` },
    );
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await createModel(loadToken(), input());
    setBusy(false);
    if (!r.ok) {
      if (r.kind === "unauthorized") onUnauthorized();
      return setMsg({ ok: false, text: describe(r, bad) });
    }
    setF(EMPTY);
    onAdded();
  };

  return (
    <form
      aria-label="添加模型"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save();
      }}
      className="flex max-w-[640px] flex-col gap-3 border border-line p-4"
    >
      <h2 className="m-0 text-base font-bold">添加模型</h2>
      <Field label="名称" id="m-name">
        <input
          id="m-name"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
          className={field}
        />
      </Field>
      <Field label="协议" id="m-api">
        <select
          id="m-api"
          value={f.api}
          onChange={(e) => set("api", e.target.value as ModelApiKind)}
          className={field}
        >
          {APIS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="接口地址" id="m-url">
        <input
          id="m-url"
          value={f.baseUrl}
          placeholder="接口根地址，含 /v1"
          onChange={(e) => set("baseUrl", e.target.value)}
          className={field}
        />
      </Field>
      <Field label="模型 ID" id="m-model">
        <input
          id="m-model"
          value={f.modelId}
          onChange={(e) => set("modelId", e.target.value)}
          className={field}
        />
      </Field>
      <Field label="API Key（本地无鉴权可留空）" id="m-key">
        <input
          id="m-key"
          type="password"
          autoComplete="off"
          value={f.apiKey}
          onChange={(e) => set("apiKey", e.target.value)}
          className={field}
        />
      </Field>
      <Field label="上下文窗口（可选）" id="m-ctx">
        <input
          id="m-ctx"
          inputMode="numeric"
          value={f.contextWindow}
          onChange={(e) => set("contextWindow", e.target.value)}
          className={field}
        />
      </Field>
      <div className="flex gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={f.reasoning}
            onChange={(e) => set("reasoning", e.target.checked)}
          />
          支持推理
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={f.image}
            onChange={(e) => set("image", e.target.checked)}
          />
          支持图片输入
        </label>
      </div>
      <details className="border border-line px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold">
          高级：兼容性与推理档位映射
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field label="最大输出 token（可选）" id="m-maxtok">
            <input
              id="m-maxtok"
              inputMode="numeric"
              value={f.maxTokens}
              onChange={(e) => set("maxTokens", e.target.value)}
              className={field}
            />
          </Field>
          <Field label="最大输出字段名" id="m-maxfield">
            <select
              id="m-maxfield"
              value={f.maxTokensField}
              onChange={(e) =>
                set("maxTokensField", e.target.value as typeof f.maxTokensField)
              }
              className={field}
            >
              <option value="">默认</option>
              <option value="max_completion_tokens">
                max_completion_tokens
              </option>
              <option value="max_tokens">max_tokens</option>
            </select>
          </Field>
          {TRI_COMPAT.map((c) => (
            <Field key={c.key} label={c.label} id={`m-${c.key}`}>
              <select
                id={`m-${c.key}`}
                value={f.tri[c.key] ?? ""}
                onChange={(e) =>
                  set("tri", { ...f.tri, [c.key]: e.target.value as Tri })
                }
                className={field}
              >
                <option value="">默认</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            </Field>
          ))}
          <fieldset className="m-0 flex flex-col gap-2 border border-line p-3">
            <legend className="px-1 text-xs font-semibold">
              推理档位映射（pi 档位 → 服务端取值）
            </legend>
            {LEVELS.map((lv) => {
              const cell = f.levels[lv] ?? { mode: "default", value: "" };
              const upd = (c: LevelCell) =>
                set("levels", { ...f.levels, [lv]: c });
              return (
                <div key={lv} className="flex items-center gap-2 text-sm">
                  <span className="w-16 font-mono text-xs">{lv}</span>
                  <select
                    aria-label={`${lv} 映射方式`}
                    value={cell.mode}
                    onChange={(e) =>
                      upd({
                        ...cell,
                        mode: e.target.value as LevelCell["mode"],
                      })
                    }
                    className={field}
                  >
                    <option value="default">默认</option>
                    <option value="unsupported">不支持</option>
                    <option value="map">映射为</option>
                  </select>
                  {cell.mode === "map" && (
                    <input
                      aria-label={`${lv} 映射值`}
                      value={cell.value}
                      onChange={(e) => upd({ ...cell, value: e.target.value })}
                      className={`${field} w-32`}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
        </div>
      </details>
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`m-0 font-semibold ${msg.ok ? "text-ok-ink" : "text-danger"}`}
        >
          {msg.text}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() => void test()}
          className={actionBtn}
        >
          测试连接
        </button>
        <button type="submit" disabled={busy || !valid} className={actionBtn}>
          保存
        </button>
      </div>
    </form>
  );
}

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

export function ModelsPanel({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | "loading" | "failed">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await listModels(loadToken());
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    setModels(r.ok ? r.data : "failed");
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (run: () => Promise<CallResult<unknown>>) => {
    setError(null);
    const r = await run();
    if (!r.ok) {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r));
    }
    await reload();
  };

  return (
    <div className="flex flex-col gap-5">
      {models === "loading" && <p className="text-mute">加载中…</p>}
      {models === "failed" && (
        <p role="alert" className="font-semibold text-danger">
          模型列表加载失败
        </p>
      )}
      {Array.isArray(models) && models.length === 0 && (
        <p className="m-0 text-mute">
          还没有登记模型。添加后，新建的会话会使用默认模型。
        </p>
      )}
      {Array.isArray(models) && models.length > 0 && (
        <ul className="m-0 flex max-w-[640px] list-none flex-col gap-2 p-0">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 border border-line px-3 py-2"
            >
              <div className="min-w-0">
                <div className="font-semibold">
                  {m.name}
                  {m.isDefault && (
                    <span className="ml-2 text-xs text-ok-ink">默认</span>
                  )}
                </div>
                <div className="truncate text-xs text-mute">
                  {m.modelId} · {m.baseUrl}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {!m.isDefault && (
                  <button
                    type="button"
                    className={actionBtn}
                    onClick={() =>
                      void act(() => setDefaultModel(loadToken(), m.id))
                    }
                  >
                    设为默认
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`删除 ${m.name}`}
                  className={dangerBtn}
                  onClick={() => void act(() => deleteModel(loadToken(), m.id))}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="m-0 font-semibold text-danger">
          {error}
        </p>
      )}
      <AddForm onAdded={() => void reload()} onUnauthorized={onUnauthorized} />
    </div>
  );
}
