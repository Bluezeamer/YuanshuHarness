// 仅测试使用：默认值设置页的假服务。供应商与 /default-model 复用供应商页的假服务，这里补 /defaults。
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type {
  AgentSettings,
  AgentSettingsDefaults,
  AgentSettingsPatch,
} from "../../../api/agentSettings";
import type { DefaultModel } from "../../../api/defaultModel";
import {
  CANVAS_MEDIA_DEFAULT,
  type ImageCompression,
  PI_IMAGE_COMPRESSION,
  type Tier,
} from "../../../api/defaults";
import type { ProviderView } from "../../../api/providers";
import { ToastHost } from "../../../ui";
import { LeaveGuardProvider } from "../frame/leave";
import { builtin, custom, fakeApi, model, reply } from "../providers/testkit";
import { DefaultsPage } from "./DefaultsPage";

export { builtin, custom, model, reply };

// 与服务端 store/defaults.ts 的校验范围一致。
const isCompression = (v: unknown): v is ImageCompression => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  const int = (x: unknown, min: number, max: number) =>
    typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
  return (
    typeof c.enabled === "boolean" &&
    int(c.maxWidth, 256, 2000) &&
    int(c.maxHeight, 256, 2000) &&
    int(c.maxBytes, 64 * 1024, 4.5 * 1024 * 1024) &&
    int(c.jpegQuality, 10, 100)
  );
};

/** pi 自己的压缩与重试取值（服务端读 ~/.pi 得到的 defaults） */
export const PI_AGENT_DEFAULTS: AgentSettingsDefaults = {
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  retry: { enabled: true, maxRetries: 3 },
};

// 与服务端 session/agent-settings.ts 的校验范围一致。
const AGENT_RANGE: Record<string, [number, number]> = {
  reserveTokens: [4096, 65536],
  keepRecentTokens: [4000, 200000],
  maxRetries: [0, 10],
};

export function fakeDefaults(
  list: ProviderView[],
  start = "~",
  compression: ImageCompression = PI_IMAGE_COMPRESSION,
  agentFile: AgentSettings = { compaction: {}, retry: {} },
) {
  const api = fakeApi(list);
  let directoryStart = start;
  let imageCompression = { ...compression };
  let permissionTier: Tier = "rules";
  let reviewModel: DefaultModel | null = null;
  let auxModel: DefaultModel | null = null;
  let jobRemindSeconds = 600;
  let goalMaxRounds: number | null = 50;
  let subagentLimits = { maxDepth: 3, perCaller: 10, perTree: 50 };
  let canvasMedia = { ...CANVAS_MEDIA_DEFAULT };
  let readFails = false;
  let putError: string | null = null;
  const agentValues: AgentSettings = structuredClone(agentFile);
  let agentError: string | null = null;
  let agentProblems: string[] = [];
  const current = () => ({
    directoryStart,
    imageCompression,
    permissionTier,
    reviewModel,
    auxModel,
    jobRemindSeconds,
    goalMaxRounds,
    subagentLimits,
    canvasMedia,
  });
  api.on("GET /api/v1/defaults", () =>
    readFails ? reply(500) : reply(200, current()),
  );
  api.on("PUT /api/v1/defaults", (body) => {
    if (putError) return reply(400, { error: putError });
    const b = body as {
      directoryStart?: unknown;
      imageCompression?: unknown;
      permissionTier?: unknown;
      reviewModel?: unknown;
      auxModel?: unknown;
      jobRemindSeconds?: unknown;
      goalMaxRounds?: unknown;
      subagentLimits?: unknown;
      canvasMedia?: unknown;
    };
    if (
      b.directoryStart === undefined &&
      b.imageCompression === undefined &&
      b.permissionTier === undefined &&
      b.reviewModel === undefined &&
      b.auxModel === undefined &&
      b.jobRemindSeconds === undefined &&
      b.goalMaxRounds === undefined &&
      b.subagentLimits === undefined &&
      b.canvasMedia === undefined
    )
      return reply(400, { error: "bad_request" });
    // 与服务端一致：「模型」档要先有审批模型，这一次一并给的也算
    const nextReview =
      b.reviewModel === undefined
        ? reviewModel
        : (b.reviewModel as DefaultModel | null);
    if (b.permissionTier === "auto" && nextReview === null)
      return reply(400, { error: "review_model_missing" });
    if (b.directoryStart !== undefined) {
      const v = b.directoryStart;
      // 与服务端一致：空、含 NUL、超过 4096 字符都是 400
      if (typeof v !== "string" || !v || v.includes("\0") || v.length > 4096)
        return reply(400, { error: "invalid_directory_start" });
      directoryStart = v;
    }
    if (b.imageCompression !== undefined) {
      if (!isCompression(b.imageCompression))
        return reply(400, { error: "invalid_image_compression" });
      imageCompression = { ...b.imageCompression };
    }
    if (b.permissionTier !== undefined)
      permissionTier = b.permissionTier as Tier;
    if (b.reviewModel !== undefined) reviewModel = nextReview;
    if (b.auxModel !== undefined) auxModel = b.auxModel as DefaultModel | null;
    if (typeof b.jobRemindSeconds === "number")
      jobRemindSeconds = b.jobRemindSeconds;
    if (b.goalMaxRounds !== undefined)
      goalMaxRounds = b.goalMaxRounds as number | null;
    if (b.subagentLimits !== undefined)
      subagentLimits = b.subagentLimits as typeof subagentLimits;
    if (b.canvasMedia !== undefined)
      canvasMedia = b.canvasMedia as typeof canvasMedia;
    return reply(200, current());
  });
  const agentView = () => ({
    file: "/data/ys/settings.json",
    values: agentValues,
    problems: agentProblems,
    defaults: PI_AGENT_DEFAULTS,
  });
  api.on("GET /api/v1/agent-settings", () => reply(200, agentView()));
  api.on("PUT /api/v1/agent-settings", (body) => {
    if (agentError)
      return reply(400, { error: "bad_request", message: agentError });
    const patch = body as AgentSettingsPatch;
    const groups = ["compaction", "retry"] as const;
    for (const g of groups)
      for (const [k, v] of Object.entries(patch[g] ?? {})) {
        const range = AGENT_RANGE[k];
        if (typeof v === "number" && range && (v < range[0] || v > range[1]))
          return reply(400, {
            error: "bad_request",
            message: `${g}.${k} 要在 ${range[0]}–${range[1]} 之间`,
          });
      }
    for (const g of groups) {
      const into = agentValues[g] as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch[g] ?? {})) {
        if (v === null) delete into[k];
        else if (v !== undefined) into[k] = v;
      }
    }
    return reply(200, agentView());
  });
  return {
    api,
    start: () => directoryStart,
    compression: () => imageCompression,
    tier: () => permissionTier,
    review: () => reviewModel,
    aux: () => auxModel,
    jobRemind: () => jobRemindSeconds,
    goalMax: () => goalMaxRounds,
    limits: () => subagentLimits,
    media: () => canvasMedia,
    /** settings.json 里现在写着的项 */
    agent: () => agentValues,
    /** 之后的 PUT /agent-settings 一律 400 并带这句话（null 恢复） */
    failAgentPut: (message: string | null) => {
      agentError = message;
    },
    /** GET 时带上的「被忽略的项」 */
    setAgentProblems: (list: string[]) => {
      agentProblems = list;
    },
    /** 之后的 GET /defaults 一律 500（false 恢复） */
    failRead: (v: boolean) => {
      readFails = v;
    },
    /** 之后的 PUT /defaults 一律返回该错误码（null 恢复） */
    failPut: (code: string | null) => {
      putError = code;
    },
  };
}

export type FakeDefaults = ReturnType<typeof fakeDefaults>;

/** 挂载默认值设置页并等到页签出现 */
export async function mountDefaults(fake: FakeDefaults) {
  vi.stubGlobal("fetch", fake.api.fetchMock);
  render(
    <LeaveGuardProvider>
      <DefaultsPage />
      <ToastHost />
    </LeaveGuardProvider>,
  );
  await screen.findByRole("tab", { name: "模型与权限" });
}

/** 一个自定义供应商：m-plain 不能思考，m-think 有 off / minimal / low / high */
export const vllm = () =>
  custom("vllm", {
    name: "自建 vllm",
    models: [
      model("m-plain"),
      model("m-think", {
        reasoning: true,
        levels: ["off", "minimal", "low", "high"],
        source: "manual",
      }),
    ],
  });
