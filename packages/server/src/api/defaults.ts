import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import { isTier } from "../permission/tier.js";
import type { ModelResolver } from "../provider/resolve.js";
import {
  type DefaultsStore,
  DIRECTORY_START_MAX,
  GOAL_MAX_ROUNDS_MAX,
  GOAL_MAX_ROUNDS_MIN,
  isBrowserMirror,
  isCanvasMedia,
  isImageCompression,
  isSubagentLimits,
  JOB_REMIND_MAX_S,
  JOB_REMIND_MIN_S,
  type ReviewModel,
} from "../store/defaults.js";
import { THINKING_LEVELS } from "../store/providers.js";

const FIELDS = [
  "directoryStart",
  "imageCompression",
  "permissionTier",
  "reviewModel",
  "auxModel",
  "jobRemindSeconds",
  "goalMaxRounds",
  "subagentLimits",
  "canvasMedia",
  "browserMirror",
] as const;

// 全局默认值：目录选择起点、输入图片自动压缩、默认审批档位、审批模型、辅助模型；默认模型走 /default-model。
export function defaultsApi(
  app: FastifyInstance,
  opts: { defaults: DefaultsStore; resolver: ModelResolver },
): void {
  const { defaults, resolver } = opts;

  app.get("/api/v1/defaults", async () => defaults.get());

  // 按字段局部更新：只改出现的字段，返回合并后的完整默认值。先全部校验，再落库。
  app.put("/api/v1/defaults", async (req, reply) => {
    const b = isObject(req.body) ? req.body : {};
    const bad = (error: string, code = 400) => reply.code(code).send({ error });
    if (FIELDS.every((k) => b[k] === undefined)) return bad("bad_request");
    const start = b.directoryStart;
    if (
      start !== undefined &&
      (typeof start !== "string" ||
        start.trim() === "" ||
        start.length > DIRECTORY_START_MAX ||
        start.includes("\0"))
    )
      return bad("invalid_directory_start");
    if (
      b.imageCompression !== undefined &&
      !isImageCompression(b.imageCompression)
    )
      return bad("invalid_image_compression");
    if (b.permissionTier !== undefined && !isTier(b.permissionTier))
      return bad("invalid_permission_tier");
    const remind = b.jobRemindSeconds;
    if (
      remind !== undefined &&
      !(
        typeof remind === "number" &&
        Number.isInteger(remind) &&
        remind >= JOB_REMIND_MIN_S &&
        remind <= JOB_REMIND_MAX_S
      )
    )
      return bad("invalid_job_remind");
    if (b.subagentLimits !== undefined && !isSubagentLimits(b.subagentLimits))
      return bad("invalid_subagent_limits");
    // null 是有效值（不限），所以不能用 truthy 判「出现了」。
    const rounds = b.goalMaxRounds;
    if (
      rounds !== undefined &&
      rounds !== null &&
      !(
        typeof rounds === "number" &&
        Number.isInteger(rounds) &&
        rounds >= GOAL_MAX_ROUNDS_MIN &&
        rounds <= GOAL_MAX_ROUNDS_MAX
      )
    )
      return bad("invalid_goal_max_rounds");
    if (b.canvasMedia !== undefined && !isCanvasMedia(b.canvasMedia))
      return bad("invalid_canvas_media");
    // 镜像地址首尾空白不算数：先 trim 再校验与保存
    const mirror =
      typeof b.browserMirror === "string"
        ? b.browserMirror.trim()
        : b.browserMirror;
    if (mirror !== undefined && !isBrowserMirror(mirror))
      return bad("invalid_browser_mirror");
    // 审批模型与辅助模型的选法一致：{provider, model, thinking?}，null = 清除
    const pickModel = (
      r: unknown,
      invalid: string,
    ): { value: ReviewModel | null } | { error: string; code?: number } => {
      if (r === null) return { value: null };
      if (!isObject(r)) return { error: invalid };
      const { provider, model, thinking } = r;
      if (typeof provider !== "string" || typeof model !== "string")
        return { error: invalid };
      if (
        thinking !== undefined &&
        thinking !== null &&
        !(THINKING_LEVELS as readonly unknown[]).includes(thinking)
      )
        return { error: "invalid_thinking" };
      if (!resolver.has(provider, model))
        return { error: "unknown_model", code: 404 };
      return {
        value: {
          provider,
          model,
          thinking: typeof thinking === "string" ? thinking : null,
        },
      };
    };
    let review: ReviewModel | null | undefined;
    if (b.reviewModel !== undefined) {
      const r = pickModel(b.reviewModel, "invalid_review_model");
      if ("error" in r) return bad(r.error, r.code);
      review = r.value;
    }
    let aux: ReviewModel | null | undefined;
    if (b.auxModel !== undefined) {
      const r = pickModel(b.auxModel, "invalid_aux_model");
      if ("error" in r) return bad(r.error, r.code);
      aux = r.value;
    }
    // 「模型」档要先有审批模型：这一次请求里一并给的也算。
    const nextReview = review === undefined ? defaults.reviewModel() : review;
    if (b.permissionTier === "auto" && nextReview === null)
      return bad("review_model_missing");

    if (typeof start === "string") defaults.setDirectoryStart(start.trim());
    if (b.imageCompression !== undefined)
      defaults.setImageCompression(b.imageCompression as never);
    if (isTier(b.permissionTier)) defaults.setPermissionTier(b.permissionTier);
    if (review !== undefined) defaults.setReviewModel(review);
    if (aux !== undefined) defaults.setAuxModel(aux);
    if (typeof remind === "number") defaults.setJobRemindSeconds(remind);
    if (rounds !== undefined)
      defaults.setGoalMaxRounds(rounds as number | null);
    if (b.subagentLimits !== undefined)
      defaults.setSubagentLimits(b.subagentLimits as never);
    if (b.canvasMedia !== undefined)
      defaults.setCanvasMedia(b.canvasMedia as never);
    if (typeof mirror === "string") defaults.setBrowserMirror(mirror);
    return defaults.get();
  });
}
