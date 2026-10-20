// 权限判定：纯函数（ADR-0030 判定顺序）。路径已解析、命令已解析、规则与档位由调用方传入。
import type { PlatformPath } from "node:path";
import type { Tier } from "../store/workspaces.js";
import {
  isInside,
  isSensitive,
  isSensitiveSelector,
  selectorEscapes,
} from "./paths.js";

export type Access = "read" | "write";

export type Action =
  // dir：记住时用的目录（文件取父目录，目录取自身），由调用方按文件系统算好。
  | {
      kind: "path";
      access: Access;
      targets: { path: string; dir: string }[];
      /** grep 的 glob、find 的 pattern：决定实际读哪些文件，同样要过敏感与 cwd 边界。 */
      selectors?: string[];
    }
  | {
      kind: "command";
      /** 原命令行（用于摘要）。 */
      line: string;
      /** 命令里所有词，用于敏感词检测。 */
      words: string[];
      /** 含无法分析的 shell 包装（bash -c 等）：只交人工、不可记住。 */
      opaque: boolean;
      /** 整条命令是出厂只读白名单的纯词连接。 */
      readOnly: boolean;
      /** 规范化命令行；不可解析为 null。 */
      normalized: string | null;
      /** 可记住（可解析、首词不在黑名单、不含 sudo）。 */
      rememberable: boolean;
      /** 含 sudo（不交审核模型）。 */
      sudo: boolean;
      /** 直接开 root shell（su、sudo -s、sudo bash）：任何档位都人工审批、不可记住（ADR-0007）。 */
      rootShell?: boolean;
    };

export interface Ctx {
  tier: Tier;
  cwd: string;
  pathRules: { access: Access; value: string }[];
  commandRules: string[];
  /** 路径方言：ssh 环境为 posix；缺省按本机平台。 */
  pm?: PlatformPath;
}

export type RememberRule =
  | { kind: "path"; access: Access; value: string }
  | { kind: "command"; access: null; value: string };

export type Decision =
  | { verdict: "allow" }
  | {
      verdict: "ask";
      /** 可记住时给出要写入的规则。 */
      remember: RememberRule | null;
      /** 可交审核模型（敏感路径、sudo 类不可）。 */
      reviewable: boolean;
    };

/** 目标已有的规则目录是否覆盖它：读规则只放行读，写规则放行读写。 */
function covered(ctx: Ctx, access: Access, t: string): boolean {
  return ctx.pathRules.some(
    (r) =>
      (r.access === "write" || access === "read") &&
      isInside(r.value, t, ctx.pm),
  );
}

export function decide(action: Action, ctx: Ctx): Decision {
  const ask = (
    remember: RememberRule | null,
    reviewable: boolean,
  ): Decision => ({
    verdict: "ask",
    remember,
    reviewable,
  });
  if (action.kind === "command" && action.rootShell) return ask(null, false);
  if (ctx.tier === "full") return { verdict: "allow" };

  if (action.kind === "path") {
    if (
      action.targets.some((t) => isSensitive(t.path)) ||
      action.selectors?.some(isSensitiveSelector)
    )
      return ask(null, false);
    // 选择器指向 cwd 外：无法落成一个目录，按规则外处理且不可记住
    if (action.selectors?.some(selectorEscapes)) return ask(null, true);
    const open = action.targets.filter(
      (t) =>
        !isInside(ctx.cwd, t.path, ctx.pm) &&
        !covered(ctx, action.access, t.path),
    );
    const first = open[0];
    if (!first) return { verdict: "allow" };
    return ask({ kind: "path", access: action.access, value: first.dir }, true);
  }

  // 命令：敏感词先于一切（含只读白名单与已记住规则）。
  if (action.opaque || action.words.some(isSensitive)) return ask(null, false);
  if (action.readOnly) return { verdict: "allow" };
  if (
    action.normalized !== null &&
    ctx.commandRules.includes(action.normalized)
  )
    return { verdict: "allow" };
  const remember: RememberRule | null =
    action.rememberable && action.normalized !== null
      ? { kind: "command", access: null, value: action.normalized }
      : null;
  return ask(remember, !action.sudo);
}
