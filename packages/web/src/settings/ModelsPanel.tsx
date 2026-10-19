import { useCallback, useEffect, useState } from "react";
import {
  type CallResult,
  createModel,
  deleteModel,
  listModels,
  loadToken,
  type ModelApiKind,
  type ModelInfo,
  type ModelInput,
  setDefaultModel,
  testModel,
} from "../api";
import { actionBtn, dangerBtn, describe, field } from "./shared";

const APIS: { id: ModelApiKind; label: string }[] = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
];

const EMPTY = {
  name: "",
  api: "openai-completions" as ModelApiKind,
  baseUrl: "",
  modelId: "",
  contextWindow: "",
  apiKey: "",
  reasoning: false,
  image: false,
};

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
  const ctx = Number(f.contextWindow);
  const input = (): ModelInput => ({
    name: f.name.trim(),
    api: f.api,
    baseUrl: f.baseUrl.trim(),
    modelId: f.modelId.trim(),
    ...(f.contextWindow && Number.isInteger(ctx) && ctx > 0
      ? { contextWindow: ctx }
      : {}),
    reasoning: f.reasoning,
    image: f.image,
    ...(f.apiKey ? { apiKey: f.apiKey } : {}),
  });
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
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`m-0 font-semibold ${msg.ok ? "text-ok" : "text-acc"}`}
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
        <p role="alert" className="font-semibold text-acc">
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
                    <span className="ml-2 text-xs text-ok">默认</span>
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
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <AddForm onAdded={() => void reload()} onUnauthorized={onUnauthorized} />
    </div>
  );
}
