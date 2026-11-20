// 休眠与认领的决策：表驱动，注册表只管执行。
import { describe, expect, test } from "vitest";
import {
  actDenied,
  canClaim,
  type PolicyPage,
  pickSleepingToDrop,
  pickSleepVictim,
} from "./policy.js";

const page = (id: string, over: Partial<PolicyPage> = {}): PolicyPage => ({
  id,
  workspaceKey: "w1",
  state: "active",
  controller: "agent",
  userOpened: false,
  lastUsedAt: 1000,
  viewers: 0,
  handoffPending: false,
  ...over,
});

describe("pickSleepVictim", () => {
  test("同键内挑最久没用的", () => {
    const pages = [
      page("a", { lastUsedAt: 3000 }),
      page("b", { lastUsedAt: 1000 }),
      page("c", { lastUsedAt: 2000 }),
    ];
    expect(pickSleepVictim(pages, "w1")?.id).toBe("b");
  });

  test("全局范围：跨键挑，最久没用的就算别的键也挑", () => {
    const pages = [
      page("a", { lastUsedAt: 1000 }),
      page("b", { lastUsedAt: 3000, workspaceKey: "w2" }),
    ];
    expect(pickSleepVictim(pages, "w1")?.id).toBe("a");
    expect(pickSleepVictim(pages, null)?.id).toBe("a");
  });

  test("同键范围不会挑到别的键的页面", () => {
    const pages = [
      page("a", { lastUsedAt: 5000 }),
      page("b", { lastUsedAt: 1000, workspaceKey: "w2" }),
    ];
    expect(pickSleepVictim(pages, "w1")?.id).toBe("a");
    expect(pickSleepVictim(pages, "w3")).toBeNull();
  });

  test("跳过用户操作中的、有观众的、等接管答复的、已休眠的、exceptId", () => {
    const pages = [
      page("user-ctl", { controller: "user", lastUsedAt: 1 }),
      page("watched", { viewers: 2, lastUsedAt: 2 }),
      page("handoff", { handoffPending: true, lastUsedAt: 3 }),
      page("sleeping", { state: "sleeping", lastUsedAt: 4 }),
      page("except", { lastUsedAt: 5 }),
      page("ok", { lastUsedAt: 6000 }),
    ];
    expect(pickSleepVictim(pages, "w1", "except")?.id).toBe("ok");
  });

  test("全受保护时返回 null", () => {
    const pages = [
      page("a", { controller: "user" }),
      page("b", { viewers: 1 }),
      page("c", { handoffPending: true }),
    ];
    expect(pickSleepVictim(pages, "w1")).toBeNull();
    expect(pickSleepVictim([], null)).toBeNull();
  });

  test("同一时间戳按 id 定序，结果稳定", () => {
    const pages = [page("b"), page("a")];
    expect(pickSleepVictim(pages, "w1")?.id).toBe("a");
  });
});

describe("pickSleepingToDrop", () => {
  test("只挑该键的、非用户页的休眠记录，最久没用的优先", () => {
    const pages = [
      page("active-old", { lastUsedAt: 1 }),
      page("mine", { state: "sleeping", userOpened: true, lastUsedAt: 2 }),
      page("other-key", {
        state: "sleeping",
        workspaceKey: "w2",
        lastUsedAt: 3,
      }),
      page("s-new", { state: "sleeping", lastUsedAt: 5000 }),
      page("s-old", { state: "sleeping", lastUsedAt: 4000 }),
    ];
    expect(pickSleepingToDrop(pages, "w1")?.id).toBe("s-old");
  });

  test("只有用户页的休眠记录时返回 null", () => {
    const pages = [
      page("mine", { state: "sleeping", userOpened: true }),
      page("active", {}),
    ];
    expect(pickSleepingToDrop(pages, "w1")).toBeNull();
  });
});

describe("actDenied", () => {
  test("用户操作中拒绝，agent 操作时放行", () => {
    expect(actDenied({ controller: "user", userOpened: true })).toBe(
      "user_controlling",
    );
    expect(actDenied({ controller: "user", userOpened: false })).toBe(
      "user_controlling",
    );
    expect(actDenied({ controller: "agent", userOpened: false })).toBeNull();
    expect(actDenied({ controller: "agent", userOpened: true })).toBeNull();
  });
});

describe("canClaim", () => {
  const busy = (busyRoots: string[]) => (root: string) =>
    busyRoots.includes(root);

  test("没有人在用时可以认领", () => {
    expect(canClaim(null, "s1", busy(["s1"]))).toBe(true);
  });

  test("在用的会话正忙时不能", () => {
    expect(canClaim("s2", "s1", busy(["s2"]))).toBe(false);
  });

  test("在用的会话此刻空闲时可以", () => {
    expect(canClaim("s2", "s1", busy([]))).toBe(true);
  });

  test("就是自己时可以，即便自己正忙", () => {
    expect(canClaim("s1", "s1", busy(["s1"]))).toBe(true);
  });
});
