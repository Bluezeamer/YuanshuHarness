// 全局默认值的持久化（meta 表 key/value）：目录选择起点、输入图片自动压缩、默认审批档位与审批模型。
// 图片压缩参数默认值与 pi 的 resizeImage 一致：2000x2000、4.5 MiB（base64 后）、JPEG 质量 80。
import { isTier, type Tier } from "../permission/tier.js";
import { GOAL_ROUND_LIMIT_DEFAULT } from "../session/goal.js";
import type { Db } from "./db.js";

export const DEFAULT_DIRECTORY_START = "~";
export const DIRECTORY_START_MAX = 4096;
/** 浏览器（Chromium）下载镜像地址的长度上限 */
export const BROWSER_MIRROR_MAX = 512;

const KEY_DIRECTORY_START = "default_directory_start";
const KEY_IMAGE_COMPRESSION = "default_image_compression";
const KEY_PERMISSION_TIER = "default_permission_tier";
const KEY_REVIEW_MODEL = "review_model";
const KEY_REVIEW_CRITERIA = "review_criteria";
const KEY_AUX_MODEL = "aux_model";
const KEY_JOB_REMIND = "job_remind_seconds";
const KEY_GOAL_MAX_ROUNDS = "goal_max_rounds";
const KEY_SUBAGENT_LIMITS = "subagent_limits";
const KEY_CANVAS_MEDIA = "canvas_media";
const KEY_BROWSER_MIRROR = "browser_mirror";

/** 后台任务提醒间隔的缺省与下限（秒）：命令、其他工具、子代理统一一个数 */
export const JOB_REMIND_DEFAULT_S = 600;
export const JOB_REMIND_MIN_S = 10;
export const JOB_REMIND_MAX_S = 24 * 3600;

/** 目标续跑的轮数上限取值范围（设置里可改成不限）。 */
export const GOAL_MAX_ROUNDS_MIN = 1;
export const GOAL_MAX_ROUNDS_MAX = 10_000;

/** 子代理的数量上限（subagent.md §6）：深度、每个调用方同时存活的、整棵树同时存活的。 */
export interface SubagentLimits {
  maxDepth: number;
  perCaller: number;
  perTree: number;
}

export const SUBAGENT_LIMITS_DEFAULT: SubagentLimits = {
  maxDepth: 3,
  perCaller: 10,
  perTree: 50,
};
export const SUBAGENT_LIMITS_RANGE = {
  maxDepth: { min: 1, max: 10 },
  perCaller: { min: 1, max: 100 },
  perTree: { min: 1, max: 500 },
} as const;

/**
 * 画布里图片与资源的处理（canvas.md §10）：缩略图怎么压、哪些东西原样给、多大的东西不显示、
 * 粘贴上来的资源多大就不进画布的 git 历史。体积类都用 MB。
 */
export interface CanvasMedia {
  /** 缩略图最长边（像素） */
  thumbMaxSide: number;
  /** 缩略图重编码成 JPEG 时的质量 */
  thumbQuality: number;
  /** GIF 不超过这个大小就原样给（保留动画），更大的只显示第一帧缩略图 */
  gifMaxMB: number;
  /** 图片原文件超过这个大小就不显示 */
  sourceMaxMB: number;
  /** 粘贴 / 拖入的资源超过这个大小就不进画布的 git 历史（历史里只记节点，文件本身不记） */
  assetGitMaxMB: number;
  /** 粘贴 / 拖入的单个文件的大小上限 */
  uploadMaxMB: number;
}

export const CANVAS_MEDIA_DEFAULT: CanvasMedia = {
  thumbMaxSide: 2000,
  thumbQuality: 85,
  gifMaxMB: 8,
  sourceMaxMB: 20,
  assetGitMaxMB: 5,
  uploadMaxMB: 500,
};

export const CANVAS_MEDIA_RANGE = {
  thumbMaxSide: { min: 256, max: 4096 },
  thumbQuality: { min: 10, max: 100 },
  gifMaxMB: { min: 1, max: 200 },
  sourceMaxMB: { min: 1, max: 200 },
  assetGitMaxMB: { min: 1, max: 1000 },
  uploadMaxMB: { min: 1, max: 4096 },
} as const;

/** 审批模型：「模型」档下替用户把关的那个模型；全局只配一个，会话不单独指定。 */
export interface ReviewModel {
  provider: string;
  model: string;
  thinking: string | null;
}

/** 辅助模型：一次性的小调用（团队的板子摘要等）用的模型，选法与审批模型一致；没配就用当前会话的模型。 */
export type AuxModel = ReviewModel;

export interface ImageCompression {
  /** 关闭后图片原样发送，不做尺寸/体积压缩。 */
  enabled: boolean;
  maxWidth: number;
  maxHeight: number;
  /** 编码后（base64）的字节上限；与 pi 的 maxBytes 口径一致。 */
  maxBytes: number;
  /** 重新编码成 JPEG 时的质量。 */
  jpegQuality: number;
}

export const PI_IMAGE_COMPRESSION: ImageCompression = {
  enabled: true,
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
  jpegQuality: 80,
};

// 上限取 pi 的默认值：SDK 在 prompt 里还会按它自己的默认策略再检查一次，
// 允许设得比 pi 默认更宽松的话实际不会生效，所以只允许收得更紧。
export const IMAGE_COMPRESSION_LIMITS = {
  maxWidth: { min: 256, max: PI_IMAGE_COMPRESSION.maxWidth },
  maxHeight: { min: 256, max: PI_IMAGE_COMPRESSION.maxHeight },
  maxBytes: { min: 64 * 1024, max: PI_IMAGE_COMPRESSION.maxBytes },
  jpegQuality: { min: 10, max: 100 },
} as const;

export interface Defaults {
  directoryStart: string;
  imageCompression: ImageCompression;
  /** 会话没覆盖时跟随的审批档位。 */
  permissionTier: Tier;
  reviewModel: ReviewModel | null;
  auxModel: AuxModel | null;
  /** 后台任务的提醒间隔（秒），调用时可以覆盖 */
  jobRemindSeconds: number;
  /** 目标续跑的轮数上限；null = 不限。 */
  goalMaxRounds: number | null;
  subagentLimits: SubagentLimits;
  canvasMedia: CanvasMedia;
  /** 浏览器下载镜像（Playwright 的下载地址前缀）；空串 = 不用镜像，走环境变量或官方源。 */
  browserMirror: string;
}

const intBetween = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** 完整校验一份压缩配置（PUT 与读库都走它）；不合法返回 false。 */
export function isImageCompression(v: unknown): v is ImageCompression {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.enabled === "boolean" &&
    intBetween(
      c.maxWidth,
      IMAGE_COMPRESSION_LIMITS.maxWidth.min,
      IMAGE_COMPRESSION_LIMITS.maxWidth.max,
    ) &&
    intBetween(
      c.maxHeight,
      IMAGE_COMPRESSION_LIMITS.maxHeight.min,
      IMAGE_COMPRESSION_LIMITS.maxHeight.max,
    ) &&
    intBetween(
      c.maxBytes,
      IMAGE_COMPRESSION_LIMITS.maxBytes.min,
      IMAGE_COMPRESSION_LIMITS.maxBytes.max,
    ) &&
    intBetween(
      c.jpegQuality,
      IMAGE_COMPRESSION_LIMITS.jpegQuality.min,
      IMAGE_COMPRESSION_LIMITS.jpegQuality.max,
    )
  );
}

/** 完整校验一份画布媒体设置（PUT 与读库都走它）。 */
export function isCanvasMedia(v: unknown): v is CanvasMedia {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return (Object.keys(CANVAS_MEDIA_RANGE) as Array<keyof CanvasMedia>).every(
    (k) =>
      intBetween(c[k], CANVAS_MEDIA_RANGE[k].min, CANVAS_MEDIA_RANGE[k].max),
  );
}

/** 浏览器下载镜像：空串（不用）或 http(s) 地址。 */
export function isBrowserMirror(v: unknown): v is string {
  if (typeof v !== "string" || v.length > BROWSER_MIRROR_MAX) return false;
  if (v === "") return true;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 完整校验一份子代理限额（PUT 与读库都走它）。 */
export function isSubagentLimits(v: unknown): v is SubagentLimits {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  const r = SUBAGENT_LIMITS_RANGE;
  return (
    intBetween(c.maxDepth, r.maxDepth.min, r.maxDepth.max) &&
    intBetween(c.perCaller, r.perCaller.min, r.perCaller.max) &&
    intBetween(c.perTree, r.perTree.min, r.perTree.max)
  );
}

export class DefaultsStore {
  constructor(private readonly db: Db) {}

  private read(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  directoryStart(): string {
    return this.read(KEY_DIRECTORY_START) ?? DEFAULT_DIRECTORY_START;
  }

  /** 请求时实时读：设置保存后下一次发消息即生效。 */
  imageCompression(): ImageCompression {
    const raw = this.read(KEY_IMAGE_COMPRESSION);
    if (raw === undefined) return { ...PI_IMAGE_COMPRESSION };
    try {
      const v: unknown = JSON.parse(raw);
      return isImageCompression(v) ? { ...v } : { ...PI_IMAGE_COMPRESSION };
    } catch {
      return { ...PI_IMAGE_COMPRESSION };
    }
  }

  /** 每次工具调用即时读：改了下一次调用就生效。 */
  permissionTier(): Tier {
    const v = this.read(KEY_PERMISSION_TIER);
    return isTier(v) ? v : "rules";
  }

  reviewModel(): ReviewModel | null {
    const raw = this.read(KEY_REVIEW_MODEL);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as ReviewModel;
    } catch {
      return null;
    }
  }

  auxModel(): AuxModel | null {
    const raw = this.read(KEY_AUX_MODEL);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as AuxModel;
    } catch {
      return null;
    }
  }

  jobRemindSeconds(): number {
    const n = Number(this.read(KEY_JOB_REMIND));
    return intBetween(n, JOB_REMIND_MIN_S, JOB_REMIND_MAX_S)
      ? n
      : JOB_REMIND_DEFAULT_S;
  }

  setJobRemindSeconds(value: number): void {
    this.write(KEY_JOB_REMIND, String(value));
  }

  /** 每次立目标时现读：改了下一次立的目标就按新的上限。 */
  goalMaxRounds(): number | null {
    const raw = this.read(KEY_GOAL_MAX_ROUNDS);
    if (raw === undefined) return GOAL_ROUND_LIMIT_DEFAULT;
    if (raw === "null") return null;
    const n = Number(raw);
    return intBetween(n, GOAL_MAX_ROUNDS_MIN, GOAL_MAX_ROUNDS_MAX)
      ? n
      : GOAL_ROUND_LIMIT_DEFAULT;
  }

  setGoalMaxRounds(value: number | null): void {
    this.write(KEY_GOAL_MAX_ROUNDS, value === null ? "null" : String(value));
  }

  /** 每次派发即时读 */
  subagentLimits(): SubagentLimits {
    const raw = this.read(KEY_SUBAGENT_LIMITS);
    if (raw === undefined) return { ...SUBAGENT_LIMITS_DEFAULT };
    try {
      const v: unknown = JSON.parse(raw);
      return isSubagentLimits(v) ? { ...v } : { ...SUBAGENT_LIMITS_DEFAULT };
    } catch {
      return { ...SUBAGENT_LIMITS_DEFAULT };
    }
  }

  setSubagentLimits(value: SubagentLimits): void {
    this.write(KEY_SUBAGENT_LIMITS, JSON.stringify(value));
  }

  /** 每次请求即时读：改了下一张图就生效。 */
  canvasMedia(): CanvasMedia {
    const raw = this.read(KEY_CANVAS_MEDIA);
    if (raw === undefined) return { ...CANVAS_MEDIA_DEFAULT };
    try {
      const v: unknown = JSON.parse(raw);
      return isCanvasMedia(v) ? { ...v } : { ...CANVAS_MEDIA_DEFAULT };
    } catch {
      return { ...CANVAS_MEDIA_DEFAULT };
    }
  }

  setCanvasMedia(value: CanvasMedia): void {
    this.write(KEY_CANVAS_MEDIA, JSON.stringify(value));
  }

  /** 每次安装浏览器时现读：改了下一次下载就生效。 */
  browserMirror(): string {
    const v = this.read(KEY_BROWSER_MIRROR);
    return isBrowserMirror(v) ? v : "";
  }

  setBrowserMirror(value: string): void {
    this.write(KEY_BROWSER_MIRROR, value);
  }

  get(): Defaults {
    return {
      directoryStart: this.directoryStart(),
      imageCompression: this.imageCompression(),
      permissionTier: this.permissionTier(),
      reviewModel: this.reviewModel(),
      auxModel: this.auxModel(),
      jobRemindSeconds: this.jobRemindSeconds(),
      goalMaxRounds: this.goalMaxRounds(),
      subagentLimits: this.subagentLimits(),
      canvasMedia: this.canvasMedia(),
      browserMirror: this.browserMirror(),
    };
  }

  setDirectoryStart(value: string): void {
    this.write(KEY_DIRECTORY_START, value);
  }

  setImageCompression(value: ImageCompression): void {
    this.write(KEY_IMAGE_COMPRESSION, JSON.stringify(value));
  }

  setPermissionTier(value: Tier): void {
    this.write(KEY_PERMISSION_TIER, value);
  }

  setReviewModel(value: ReviewModel | null): void {
    if (value === null)
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(KEY_REVIEW_MODEL);
    else this.write(KEY_REVIEW_MODEL, JSON.stringify(value));
  }

  /** 审核的判别准则：每次审核现读，改了下一次审核就生效；null = 没自定义，用默认准则。 */
  reviewCriteria(): string | null {
    return this.read(KEY_REVIEW_CRITERIA) ?? null;
  }

  setReviewCriteria(value: string | null): void {
    if (value === null)
      this.db
        .prepare("DELETE FROM meta WHERE key = ?")
        .run(KEY_REVIEW_CRITERIA);
    else this.write(KEY_REVIEW_CRITERIA, value);
  }

  setAuxModel(value: AuxModel | null): void {
    if (value === null)
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(KEY_AUX_MODEL);
    else this.write(KEY_AUX_MODEL, JSON.stringify(value));
  }
}
