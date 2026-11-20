// 工作区表单：新建与编辑共用。主目录、附加目录、名称描述、项目约定、新会话默认配置。
import type { Tier } from "../../../../api/defaults";
import type {
  DirectoryInput,
  Workspace,
  WorkspaceDefaults,
  WorkspaceReviewPolicy,
} from "../../../../api/workspaces";
import { blankDir, type DirRowValue } from "../editors/DirRow";
import { type Catalog, localHostIdOf } from "./catalog";
import { baseName, isAbsolute, normDir } from "./path";
import { type ModelValue, pickStart } from "./session";

export type WorkspaceMode = "create" | "edit";

/** 一个工作区至多挂几个目录（含主目录），与服务端一致 */
export const DIRECTORIES_MAX = 12;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 500;
/** 工作区的审核要求的长度上限，与服务端一致 */
export const REVIEW_POLICY_MAX = 4000;

/** 新会话默认配置：每项「跟随全局」或「覆盖」 */
export interface DefaultsForm {
  /** 空 = 跟随（用库里第一个 Agent） */
  agentPresetId: string;
  modePresetIds: string[];
  model: ModelValue;
  permissionTier: Tier | null;
}

export interface WorkspaceForm {
  primary: DirRowValue;
  extras: DirRowValue[];
  /** 空 = 取主目录的目录名 */
  name: string;
  description: string;
  defaults: DefaultsForm;
  reviewPolicy: WorkspaceReviewPolicy;
}

export const blankDefaults = (cat: Catalog): DefaultsForm => ({
  agentPresetId: "",
  modePresetIds: [],
  model: { mode: "follow", ...pickStart(cat) },
  permissionTier: null,
});

export const blankWorkspaceForm = (cat: Catalog): WorkspaceForm => ({
  primary: blankDir(localHostIdOf(cat)),
  extras: [],
  name: "",
  description: "",
  defaults: blankDefaults(cat),
  reviewPolicy: { mode: "append", text: "" },
});

const rowOf = (d: Workspace["directories"][number]): DirRowValue => ({
  ...blankDir(d.environmentId, d.path),
  id: d.id,
});

export function formFromWorkspace(ws: Workspace, cat: Catalog): WorkspaceForm {
  const d = ws.defaults;
  const [primary, ...extras] = ws.directories;
  const base = blankDefaults(cat);
  return {
    primary: primary ? rowOf(primary) : blankDir(localHostIdOf(cat)),
    extras: extras.map(rowOf),
    name: ws.name,
    description: ws.description,
    defaults: {
      agentPresetId: d.agentPresetId ?? "",
      modePresetIds: d.modePresetIds ?? [],
      model: d.model ? { mode: "pick", ...d.model } : base.model,
      permissionTier: (d.permissionTier as Tier | undefined) ?? null,
    },
    reviewPolicy: ws.reviewPolicy,
  };
}

/** 稀疏默认配置：只写覆盖了的项，没写的跟随全局 */
export function toDefaults(d: DefaultsForm): WorkspaceDefaults {
  return {
    ...(d.agentPresetId ? { agentPresetId: d.agentPresetId } : {}),
    ...(d.modePresetIds.length ? { modePresetIds: d.modePresetIds } : {}),
    ...(d.model.mode === "pick"
      ? {
          model: {
            provider: d.model.provider,
            model: d.model.model,
            reasoning: d.model.reasoning || "off",
          },
        }
      : {}),
    ...(d.permissionTier ? { permissionTier: d.permissionTier } : {}),
  };
}

/** 提交用的审核要求：文字去掉首尾空白 */
export const toReviewPolicy = (
  p: WorkspaceReviewPolicy,
): WorkspaceReviewPolicy => ({ mode: p.mode, text: p.text.trim() });

/** 被覆盖的项数（摘要行的备注） */
export const overriddenCount = (d: DefaultsForm): number =>
  Object.keys(toDefaults(d)).length;

export const dirInput = (r: DirRowValue): DirectoryInput => ({
  environmentId: r.host,
  path: normDir(r.path),
});

/** 目录清单，主目录在前 */
export const dirInputs = (f: WorkspaceForm): DirectoryInput[] =>
  [f.primary, ...f.extras].map(dirInput);

export const dirKey = (r: Pick<DirRowValue, "host" | "path">): string =>
  `${r.host}\n${normDir(r.path)}`;

/** 名称留空时用的默认名 */
export const defaultName = (f: WorkspaceForm): string =>
  baseName(normDir(f.primary.path)) || "";

/** 这个主目录已是哪个工作区的主目录（再建等于打开它） */
export const ownerOf = (
  workspaces: readonly Workspace[],
  primary: DirRowValue,
): Workspace | undefined =>
  workspaces.find((w) => {
    const p = w.directories[0];
    return (
      p && dirKey({ host: p.environmentId, path: p.path }) === dirKey(primary)
    );
  });

/** 阻止提交的原因；null = 可以提交 */
export function workspaceIssue(f: WorkspaceForm): string | null {
  if (!f.primary.id && !isAbsolute(f.primary.path))
    return "还没有选主目录：点输入框或右侧按钮挑一个。";
  if (f.extras.length + 1 > DIRECTORIES_MAX)
    return `目录最多 ${DIRECTORIES_MAX} 个（含主目录）。`;
  const bad = f.extras.findIndex((r) => !r.id && !isAbsolute(r.path));
  if (bad >= 0) return `附加目录 ${bad + 1} 需为绝对路径（以 / 开头）。`;
  const seen = new Set<string>();
  for (const [i, r] of [f.primary, ...f.extras].entries()) {
    const k = dirKey(r);
    if (seen.has(k))
      return `${i === 0 ? "主目录" : `附加目录 ${i}`} 重复了（同一台主机的同一目录只能挂一次）。`;
    seen.add(k);
  }
  return null;
}

/** 目录清单相对 orig 的变化：用已有目录的 id 比，新增的行没有 id */
export const dirsChanged = (f: WorkspaceForm, orig: WorkspaceForm): boolean =>
  f.extras.length !== orig.extras.length ||
  f.extras.some((r, i) => !r.id || r.id !== orig.extras[i]?.id);
