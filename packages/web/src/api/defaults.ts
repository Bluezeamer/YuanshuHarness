import type { DefaultModel } from "./defaultModel";
import { request } from "./http";

/** 审批档位：规则 → 模型（交审批模型）→ 通过。全局默认一份，会话可覆盖。 */
export type Tier = "rules" | "auto" | "full";
export const TIERS: readonly Tier[] = ["rules", "auto", "full"];
export const TIER_LABEL: Record<Tier, string> = {
  rules: "规则",
  auto: "模型",
  full: "通过",
};
export const TIER_HINT: Record<Tier, string> = {
  rules: "规则内的动作直接放行，越界才问你",
  auto: "越界的动作先交审批模型，它拿不准才问你",
  full: "规则外也直接放行；开 root shell、用隐私变量这类仍会问你",
};

/** 输入图片自动压缩参数；默认值（2000x2000、4.5 MiB、JPEG 80）与 pi 的 resizeImage 一致。 */
export interface ImageCompression {
  /** 关闭后图片原样发送，不做尺寸/体积压缩。 */
  enabled: boolean;
  maxWidth: number;
  maxHeight: number;
  /** 编码后（base64）的字节上限。 */
  maxBytes: number;
  jpegQuality: number;
}

/** 画布里图片与资源的处理；与服务端 store/defaults.ts 一致，体积都是 MB */
export interface CanvasMedia {
  /** 缩略图最长边（像素） */
  thumbMaxSide: number;
  /** 缩略图重编码成 JPEG 的质量 */
  thumbQuality: number;
  /** GIF 不超过这个大小就原样给（保留动画），更大的只显示第一帧 */
  gifMaxMB: number;
  /** 图片原文件超过这个大小就不显示 */
  sourceMaxMB: number;
  /** 粘贴 / 拖入的资源超过这个大小就不进画布的 git 历史 */
  assetGitMaxMB: number;
  /** 粘贴 / 拖入的单个文件的大小上限 */
  uploadMaxMB: number;
}

export interface SubagentLimits {
  maxDepth: number;
  perCaller: number;
  perTree: number;
}

// 与服务端 GET/PUT /api/v1/defaults 对应：全局默认值设置。
export interface Defaults {
  /** 选目录的起点；`~` 与 `~/子路径` 在各主机上展开为各自的家目录 */
  directoryStart: string;
  imageCompression: ImageCompression;
  /** 会话没覆盖时跟随的审批档位 */
  permissionTier: Tier;
  /** 「模型」档下替你把关的模型；没配时「模型」档不可选 */
  reviewModel: DefaultModel | null;
  /** 一次性小调用（团队的板子摘要等）用的模型；没配就用当前会话的模型 */
  auxModel: DefaultModel | null;
  /** 后台任务的提醒间隔（秒）；agent 调用时可以覆盖 */
  jobRemindSeconds: number;
  /** 目标续跑的轮数上限（新建的目标取这个值，之后可在目标上改）；null = 不限 */
  goalMaxRounds: number | null;
  /** 子代理的数量上限 */
  subagentLimits: SubagentLimits;
  canvasMedia: CanvasMedia;
  /** 浏览器（Chromium）下载镜像地址；空串 = 不用，走环境变量或官方源 */
  browserMirror: string;
}

export interface TierChoice {
  /** null = 不覆盖，跟随全局 */
  value: Tier | null;
  label: string;
  hint: string;
  disabled?: boolean;
}

/**
 * 会话与创建面板里的档位选项：第一项是「跟随全局」并写明当前全局值（X02，可随时恢复）；
 * 没配审批模型时「模型」档置灰并提示去哪配。
 */
export function tierChoices(
  global: Tier,
  hasReviewModel: boolean,
): TierChoice[] {
  return [
    {
      value: null,
      label: `跟随全局 · ${TIER_LABEL[global]}`,
      hint: "不覆盖，全局默认怎么改它就怎么变",
    },
    ...TIERS.map((t) => ({
      value: t,
      label: TIER_LABEL[t],
      hint:
        t === "auto" && !hasReviewModel
          ? "先在「设置 · 默认值」里配审批模型"
          : TIER_HINT[t],
      ...(t === "auto" && !hasReviewModel ? { disabled: true } : {}),
    })),
  ];
}

/** 服务端没有设置过、或读不到时的取值 */
export const DEFAULT_DIRECTORY_START = "~";

/** 服务端没有设置过时的图片压缩参数（与 pi 默认策略一致） */
export const PI_IMAGE_COMPRESSION: ImageCompression = {
  enabled: true,
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
  jpegQuality: 80,
};

/** 服务端没有设置过时的画布媒体设置 */
export const CANVAS_MEDIA_DEFAULT: CanvasMedia = {
  thumbMaxSide: 2000,
  thumbQuality: 85,
  gifMaxMB: 8,
  sourceMaxMB: 20,
  assetGitMaxMB: 5,
  uploadMaxMB: 500,
};

export const getDefaults = (token: string | null) =>
  request<Defaults>("GET", "/api/v1/defaults", token);

/** 按字段局部更新：只传要改的分区，其余保持服务端现值。 */
export const putDefaults = (token: string | null, value: Partial<Defaults>) =>
  request<Defaults>("PUT", "/api/v1/defaults", token, value);
