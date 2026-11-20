import { ApiError } from "../../../api/http";
import {
  conflictOf,
  createSessionWithConfig,
  patchSessionConfig,
  type SessionConfig,
} from "../../../api/sessionConfig";
import { patchLibrarySession } from "../../../api/sessionLibrary";
import { putSessionModes } from "../../../api/sessionModes";
import { failureText } from "./model/errors";
import { type SessionForm, toBody, toPatch } from "./model/session";

export type SessionOutcome =
  | {
      ok: true;
      id: string;
      /** 运行中的会话：配置哪一轮起生效，要告诉用户 */
      later?: string;
      note?: string;
    }
  | { ok: false; error: string }
  /** 编辑时 rev 过期：current 是服务端当前值（取不到时为 null） */
  | { ok: false; conflict: SessionConfig | null };

const failure = (err: unknown): { ok: false; error: string } => ({
  ok: false,
  error: failureText(err),
});

/** 新建（含「以此配置新建」）：先建会话再写名字；名字没写进去不算整次失败 */
export async function createSession(
  token: string | null,
  workspaceId: string,
  form: SessionForm,
): Promise<SessionOutcome> {
  try {
    const { id } = await createSessionWithConfig(token, {
      workspaceId,
      ...(form.promptPresetId ? { promptPresetId: form.promptPresetId } : {}),
      ...(form.modePresetIds.length
        ? { modePresetIds: form.modePresetIds }
        : {}),
      config: toBody(form),
    });
    const title = form.title.trim();
    if (title === "") return { ok: true, id };
    try {
      await patchLibrarySession(token, id, { title });
    } catch {
      return {
        ok: true,
        id,
        note: "会话已创建，但名称没能写入，请在列表里重命名。",
      };
    }
    return { ok: true, id };
  } catch (err) {
    return failure(err);
  }
}

// 服务端对运行中的会话：模型本轮结束就换；能力在下一轮开头生效，模型会收到状态通知。
function laterNote(patch: object): string | undefined {
  const parts = [
    "model" in patch && "模型的改动在当前这一轮结束后生效",
    "capabilities" in patch && "能力的改动在下一轮开头生效，agent 会收到通知",
  ].filter(Boolean);
  return parts.length ? `已保存；${parts.join("；")}。` : undefined;
}

/** 编辑：模式清单、配置分区（相对 orig 有变化的）、名字；409 交给调用方让用户选 */
export async function saveSession(
  token: string | null,
  id: string,
  form: SessionForm,
  orig: SessionForm,
  baseRev: number,
): Promise<SessionOutcome> {
  try {
    // 当前模式被移出清单时服务端一并退出该模式
    if (form.modePresetIds.join("\n") !== orig.modePresetIds.join("\n"))
      await putSessionModes(token, id, { modePresetIds: form.modePresetIds });
    const patch = toPatch(form, orig);
    const applied =
      Object.keys(patch).length > 0
        ? await patchSessionConfig(token, id, baseRev, patch)
        : null;
    if (form.title.trim() !== orig.title.trim())
      await patchLibrarySession(token, id, { title: form.title.trim() });
    const later =
      applied?.appliedAt === "next-run" ? laterNote(patch) : undefined;
    return { ok: true, id, ...(later ? { later } : {}) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409)
      return { ok: false, conflict: conflictOf(err) };
    return failure(err);
  }
}
