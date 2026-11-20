// 工作区的提交步骤：对话框按步骤调用，中间要问用户（移除目录的影响）就停下来。
import { applyProjectAgentsMd } from "../../../api/agentsMd";
import { ApiError, loadToken } from "../../../api/http";
import { setWorkspaceVariables } from "../../../api/variables";
import {
  setWorkspaceCapabilities,
  type WorkspaceCapabilities,
} from "../../../api/workspaceCapabilities";
import {
  createWorkspace,
  type DirectoryPreview,
  patchWorkspace,
  previewDirectories,
  setDirectories,
  type Workspace,
} from "../../../api/workspaces";
import { failureText } from "./model/errors";
import {
  dirInputs,
  dirsChanged,
  toDefaults,
  toReviewPolicy,
  type WorkspaceForm,
} from "./model/workspace";

export type Step<T> = { ok: true; value: T } | { ok: false; error: string };

const run = async <T>(fn: () => Promise<T>): Promise<Step<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: failureText(err) };
  }
};

/** 新建；同一主目录已是某工作区的主目录时服务端返回那一个 */
export const createWorkspaceStep = (form: WorkspaceForm) =>
  run(() => {
    const name = form.name.trim();
    const description = form.description.trim();
    return createWorkspace(loadToken(), {
      directories: dirInputs(form),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      defaults: toDefaults(form.defaults),
    });
  });

/** 名称、描述、默认配置、审核要求：只提交相对 orig 变了的；都没变就不发请求 */
export const patchWorkspaceStep = (
  ws: Workspace,
  form: WorkspaceForm,
  orig: WorkspaceForm,
) =>
  run(async () => {
    const patch: Parameters<typeof patchWorkspace>[2] = {};
    if (form.name.trim() !== orig.name.trim()) patch.name = form.name.trim();
    if (form.description.trim() !== orig.description.trim())
      patch.description = form.description.trim();
    const defaults = toDefaults(form.defaults);
    if (JSON.stringify(defaults) !== JSON.stringify(toDefaults(orig.defaults)))
      patch.defaults = defaults;
    const review = toReviewPolicy(form.reviewPolicy);
    if (
      JSON.stringify(review) !==
      JSON.stringify(toReviewPolicy(orig.reviewPolicy))
    )
      patch.reviewPolicy = review;
    return Object.keys(patch).length === 0
      ? ws
      : patchWorkspace(loadToken(), ws.id, patch);
  });

/** 目录清单没变返回 null；变了先问服务端会连带删掉什么 */
export const previewDirsStep = (
  ws: Workspace,
  form: WorkspaceForm,
  orig: WorkspaceForm,
): Promise<Step<DirectoryPreview | null>> =>
  run(async () =>
    dirsChanged(form, orig)
      ? previewDirectories(loadToken(), ws.id, dirInputs(form))
      : null,
  );

export const applyDirsStep = (ws: Workspace, form: WorkspaceForm) =>
  run(() => setDirectories(loadToken(), ws.id, dirInputs(form)));

/** 整份替换这个工作区启用的变量；调用方只在清单变了时才调。 */
export const setVariablesStep = (workspaceId: string, ids: string[]) =>
  run(() => setWorkspaceVariables(loadToken(), workspaceId, ids));

/** 整份替换这个工作区勾选的技能与 MCP；调用方只在勾选变了时才调。 */
export const setCapabilitiesStep = (
  workspaceId: string,
  picked: WorkspaceCapabilities,
) => run(() => setWorkspaceCapabilities(loadToken(), workspaceId, picked));

/** 把项目 AGENTS.md 模板写进主目录；目录里已有文件又没选写法时返回 "exists"，让用户选追加 / 覆盖 / 不写 */
export const applyAgentsMdStep = (
  workspaceId: string,
  presetId: string,
  mode?: "overwrite" | "append",
): Promise<Step<"written" | "exists">> =>
  run(async () => {
    try {
      await applyProjectAgentsMd(loadToken(), workspaceId, presetId, mode);
      return "written" as const;
    } catch (err) {
      if (err instanceof ApiError && err.code === "file_exists")
        return "exists" as const;
      throw err;
    }
  });
