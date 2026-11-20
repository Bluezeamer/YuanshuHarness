// 页面模型的决策部分：谁该休眠、谁该被删、谁能动手。纯函数，注册表只负责执行。
export interface PolicyPage {
  id: string;
  workspaceKey: string;
  state: "active" | "sleeping";
  controller: "agent" | "user";
  userOpened: boolean;
  /** 毫秒时间戳，越大越近。 */
  lastUsedAt: number;
  viewers: number;
  handoffPending: boolean;
}

// 可以休眠 = 激活中、agent 在操作、没人在看、没在等用户答复接管请求。
const sleepable = (p: PolicyPage) =>
  p.state === "active" &&
  p.controller === "agent" &&
  p.viewers === 0 &&
  !p.handoffPending;

const oldest = (pages: PolicyPage[]) =>
  pages.reduce<PolicyPage | null>(
    (best, p) =>
      best === null || p.lastUsedAt < best.lastUsedAt
        ? p
        : p.lastUsedAt === best.lastUsedAt && p.id < best.id
          ? p
          : best,
    null,
  );

/**
 * 达到上限时挑谁休眠：scope 为键时同键内找，为 null 时全局找。
 * 挑不出（都受保护）返回 null，由调用方报上限。
 */
export function pickSleepVictim(
  pages: PolicyPage[],
  scope: string | null,
  exceptId?: string,
): PolicyPage | null {
  return oldest(
    pages.filter(
      (p) =>
        sleepable(p) &&
        p.id !== exceptId &&
        (scope === null || p.workspaceKey === scope),
    ),
  );
}

/** 休眠记录超出上限时挑谁删：该键里最久没用的非用户页休眠记录；没有返回 null。 */
export function pickSleepingToDrop(
  pages: PolicyPage[],
  workspaceKey: string,
): PolicyPage | null {
  return oldest(
    pages.filter(
      (p) =>
        p.state === "sleeping" &&
        !p.userOpened &&
        p.workspaceKey === workspaceKey,
    ),
  );
}

/** agent 能不能动手（用户的页面交还前、用户手动操作期间都不能）。 */
export function actDenied(page: {
  controller: "agent" | "user";
  userOpened: boolean;
}): "user_controlling" | null {
  return page.controller === "user" ? "user_controlling" : null;
}

/** 没有人在用、在用的会话此刻没在跑一轮（或就是自己）时可以认领。 */
export function canClaim(
  inUseBy: string | null,
  actorRoot: string,
  isBusy: (root: string) => boolean,
): boolean {
  if (inUseBy === null || inUseBy === actorRoot) return true;
  return !isBusy(inUseBy);
}
