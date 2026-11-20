// 打开外部站点前的审批：工具自己判定要不要问（文件与本工作区见过的服务免审批），问的方式在这里：
// 完全允许档或工具规则放行就直接过，否则弹一张卡片；通过后记在工作区里，之后不再问这个站点 / 端口。
import type { PromptResult, PromptSpec } from "../../session/prompts.js";

/** 审批结果：通过，或被拒（note 是用户写的理由，没写为空串）。 */
export type Verdict = { allowed: true } | { allowed: false; note: string };

const pass: Verdict = { allowed: true };

/** 审批答复 → 结果：只有 optionId 是 "allow" 的答复算通过，其余（含只写字、超时、取消）都是被拒。 */
export const answerVerdict = (r: PromptResult): Verdict =>
  r.outcome === "answered" && r.optionId === "allow"
    ? pass
    : { allowed: false, note: r.outcome === "answered" ? (r.text ?? "") : "" };

/** 拒绝说明后面接用户写的理由；没写就原样返回。 */
export const withNote = (reason: string, note: string): string =>
  note.trim() ? `${reason}\n用户补充：${note.trim()}` : reason;

export interface ApproveOpenDeps {
  /** 完全允许档或工具规则放行：不问，直接过。 */
  auto(): boolean;
  ask(spec: PromptSpec): Promise<PromptResult>;
  /** 通过后记下：这个工作区不再问这个站点。 */
  remember(origin: string): void;
  audit(rec: {
    decision: "allow" | "deny";
    by: "tier" | "user" | "timeout" | "cancelled";
    origin: string;
  }): void;
}

export function createApproveOpen(
  deps: ApproveOpenDeps,
): (args: {
  origin: string;
  reason: string;
  service?: boolean;
}) => Promise<Verdict> {
  return async ({ origin, reason, service }) => {
    if (deps.auto()) {
      deps.remember(origin);
      deps.audit({ decision: "allow", by: "tier", origin });
      return pass;
    }
    const r = await deps.ask({
      source: "approval",
      input: "text",
      title: service
        ? "允许 agent 访问这个服务？"
        : "允许 agent 访问这个站点？",
      body: service
        ? `${origin}\n\n${reason}\n\n通过后，这个工作区里的 agent 之后可以直接访问这个端口。`
        : `${origin}\n\n${reason}\n\n通过后，这个工作区里的 agent 之后可以直接访问该站点；页面内容来自网络，不可信。`,
      options: [
        { id: "allow", label: "通过（本工作区不再问这个站点）" },
        { id: "deny", label: "拒绝" },
      ],
      detail: { tool: "browser_open", summary: origin },
    });
    if (r.outcome !== "answered") {
      deps.audit({ decision: "deny", by: r.outcome, origin });
      return answerVerdict(r);
    }
    if (r.optionId !== "allow") {
      deps.audit({ decision: "deny", by: "user", origin });
      return answerVerdict(r);
    }
    deps.remember(origin);
    deps.audit({ decision: "allow", by: "user", origin });
    return pass;
  };
}

export interface ApproveDownloadDeps {
  /** 完全允许档：不问，直接过。 */
  auto(): boolean;
  ask(spec: PromptSpec): Promise<PromptResult>;
  audit(rec: {
    decision: "allow" | "deny";
    by: "tier" | "user" | "timeout" | "cancelled";
    filename: string;
    origin: string;
  }): void;
}

// 下载审批：默认每次问，没有「记住」这一片（文件是不可信的，同意一次不等于同意以后每一个）。
// 地址的截断在工具层做（见 download.ts），卡片只管排版。
export function createApproveDownload(
  deps: ApproveDownloadDeps,
): (args: {
  filename: string;
  pageUrl: string;
  fileUrl: string;
  executable: boolean;
}) => Promise<Verdict> {
  return async ({ filename, pageUrl, fileUrl, executable }) => {
    if (deps.auto()) {
      deps.audit({
        decision: "allow",
        by: "tier",
        filename,
        origin: pageUrl,
      });
      return pass;
    }
    const body = `文件：${filename}\n来源页面：${pageUrl}\n文件地址：${fileUrl}\n\n通过后，文件会存进本会话的附件区（不会自动打开或执行）；下载的内容来自网络，不可信。`;
    const r = await deps.ask({
      source: "approval",
      input: "text",
      title: "允许 agent 下载这个文件？",
      body: executable
        ? `⚠ 这是可执行类文件，下载后不要运行它。\n\n${body}`
        : body,
      options: [
        { id: "allow", label: "通过" },
        { id: "deny", label: "拒绝" },
      ],
      detail: { tool: "browser_download", summary: filename },
    });
    if (r.outcome !== "answered") {
      deps.audit({
        decision: "deny",
        by: r.outcome,
        filename,
        origin: pageUrl,
      });
      return answerVerdict(r);
    }
    if (r.optionId !== "allow") {
      deps.audit({ decision: "deny", by: "user", filename, origin: pageUrl });
      return answerVerdict(r);
    }
    deps.audit({ decision: "allow", by: "user", filename, origin: pageUrl });
    return pass;
  };
}

export interface ApproveUploadDeps {
  /** 完全允许档或工具规则放行：不问，直接过。 */
  auto(): boolean;
  ask(spec: PromptSpec): Promise<PromptResult>;
  audit(rec: {
    decision: "allow" | "deny";
    by: "tier" | "user" | "timeout" | "cancelled";
    origin: string;
    files: string[];
  }): void;
}

// 上传审批：每次问，没有「记住」（文件一旦交出去就收不回来）。
// 目标站点取页面此刻的地址（由工具层传），不取模型写的任何东西。
// 已知局限：卡片里的目标是页面地址，页面里的表单可能把文件提交到别的站点，这里不解析表单。
export function createApproveUpload(
  deps: ApproveUploadDeps,
): (args: {
  origin: string;
  pageUrl: string;
  files: { name: string; sizeText: string; display: string }[];
}) => Promise<Verdict> {
  return async ({ origin, pageUrl, files }) => {
    const names = files.map((f) => f.name);
    if (deps.auto()) {
      deps.audit({ decision: "allow", by: "tier", origin, files: names });
      return pass;
    }
    const list = files
      .map((f) => `- ${f.name}（${f.sizeText}）← ${f.display}`)
      .join("\n");
    const r = await deps.ask({
      source: "approval",
      input: "text",
      title: "允许 agent 上传文件？",
      body: `目标站点：${origin}\n页面：${pageUrl}\n\n文件：\n${list}\n\n通过后，这些文件会交给该页面里的上传入口；页面内容来自网络，不可信，文件一旦上传就无法收回。`,
      options: [
        { id: "allow", label: "通过" },
        { id: "deny", label: "拒绝" },
      ],
      detail: {
        tool: "browser_upload",
        summary: `${files.length} 个文件 → ${origin}`,
      },
    });
    if (r.outcome !== "answered") {
      deps.audit({ decision: "deny", by: r.outcome, origin, files: names });
      return answerVerdict(r);
    }
    if (r.optionId !== "allow") {
      deps.audit({ decision: "deny", by: "user", origin, files: names });
      return answerVerdict(r);
    }
    deps.audit({ decision: "allow", by: "user", origin, files: names });
    return pass;
  };
}
