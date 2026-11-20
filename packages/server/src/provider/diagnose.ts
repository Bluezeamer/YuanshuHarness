import type { LastTest, StageName } from "../store/providers.js";
import {
  fetchModelIds,
  type ProbeTarget,
  pingEndpoint,
  StageError,
} from "./probe.js";

export interface StageResult {
  state: "ok" | "fail" | "skip";
  ms: number;
  error?: string;
}

export interface TestResult {
  ok: boolean;
  failedStage: StageName | null;
  errorCode: string | null;
  stages: Record<StageName, StageResult>;
  lastTest: LastTest;
}

export interface DiagnoseInput {
  /** 缺省表示没有可探测的 HTTP 端点（云凭据类），端点与模型列表两个阶段跳过。 */
  probe?: ProbeTarget;
  /** 没有凭据且必须有凭据时，第一阶段失败，并给出怎么配的提示。 */
  credential: { ok: boolean; hint: string };
  /** 本次用到的所有秘密值（key 与鉴权头里的令牌）；错误文本回显前要遮掉。 */
  secrets: string[];
  /** 指定要测的模型；缺省取 preferred 里端点也有的第一个，再缺省取端点列表第一个，最后取 preferred[0]。 */
  modelId?: string;
  preferred?: string[];
  timeoutMs: number;
  /** 发最小补全请求，收到第一个 token 就返回；失败抛 StageError。 */
  firstToken: (modelId: string, signal: AbortSignal) => Promise<void>;
}

const elapsed = (since: number) => Math.round(performance.now() - since);

// 错误文本里不得出现 key（上游有时会回显请求头或 URL）。
const redact = (msg: string, secrets: string[]) =>
  secrets.reduce((m, s) => (s.length >= 4 ? m.split(s).join("••••") : m), msg);

/** 四阶段连接测试：凭据 → 端点 → 模型列表 → 首 token。前一阶段失败，后面的标 skip。 */
export async function diagnose(i: DiagnoseInput): Promise<TestResult> {
  const stages: Record<StageName, StageResult> = {
    credential: { state: "skip", ms: 0 },
    endpoint: { state: "skip", ms: 0 },
    models: { state: "skip", ms: 0 },
    token: { state: "skip", ms: 0 },
  };
  // 放进对象里：step 在闭包里赋值，局部变量会被 TS 窄化成永远为 null。
  const run: { failed: { stage: StageName; code: string } | null } = {
    failed: null,
  };
  const started = performance.now();

  async function step<T>(
    name: StageName,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    if (run.failed) return undefined;
    const t = performance.now();
    try {
      const v = await fn();
      stages[name] = { state: "ok", ms: elapsed(t) };
      return v;
    } catch (err) {
      const e =
        err instanceof StageError
          ? err
          : new StageError(
              "unknown",
              err instanceof Error ? err.message : String(err),
            );
      stages[name] = {
        state: "fail",
        ms: elapsed(t),
        error: redact(e.message, i.secrets),
      };
      run.failed = { stage: name, code: e.code };
      return undefined;
    }
  }

  await step("credential", async () => {
    if (!i.credential.ok)
      throw new StageError("no_credential", i.credential.hint);
  });

  let ids: string[] = [];
  if (i.probe) {
    const probe = i.probe;
    await step("endpoint", () => pingEndpoint(probe.baseUrl, i.timeoutMs));
    ids =
      (await step("models", async () => {
        const list = await fetchModelIds(probe, i.timeoutMs);
        if (list.length === 0)
          throw new StageError("empty_model_list", "端点返回了空的模型列表");
        return list;
      })) ?? [];
  }

  const pref = i.preferred ?? [];
  const modelId =
    i.modelId ?? pref.find((m) => ids.includes(m)) ?? ids[0] ?? pref[0];
  await step("token", async () => {
    if (!modelId) throw new StageError("no_model", "没有可用于测试的模型");
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new StageError("timeout", "首 token 超时")),
      i.timeoutMs,
    );
    try {
      await i.firstToken(modelId, ac.signal);
    } catch (err) {
      // 超时由上面的 abort 触发，pi 把它包成普通错误；按原因还原。
      if (ac.signal.aborted && ac.signal.reason instanceof StageError)
        throw ac.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });

  const total = elapsed(started);
  const { failed } = run;
  const ok = failed === null;
  const stage: StageName = failed?.stage ?? "token";
  return {
    ok,
    failedStage: failed?.stage ?? null,
    errorCode: failed?.code ?? null,
    stages,
    lastTest: {
      at: new Date().toISOString(),
      ok,
      ttft: ok ? stages.token.ms : 0,
      total,
      stage,
      ...(failed ? { errorCode: failed.code } : {}),
    },
  };
}
