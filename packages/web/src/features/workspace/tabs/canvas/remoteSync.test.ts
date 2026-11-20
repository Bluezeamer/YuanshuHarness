import { describe, expect, test } from "vitest";
import type { MirrorStatus } from "../../../../api/canvas";
import { syncBadge } from "./remoteSync";

const st = (p: Partial<MirrorStatus>): MirrorStatus => ({
  state: "synced",
  pending: 0,
  asides: [],
  ...p,
});

describe("syncBadge", () => {
  test("没有副本或已一致：不显示", () => {
    expect(syncBadge(null)).toBeNull();
    expect(syncBadge(st({}))).toBeNull();
  });

  test("待推送与推送中：同步到远端，带待推数", () => {
    for (const state of ["pending", "syncing"] as const) {
      const b = syncBadge(st({ state, pending: 3 }));
      expect(b).toMatchObject({ text: "同步到远端", busy: true });
      expect(b?.tip).toContain("3 项");
    }
  });

  test("离线：带原因，不转圈", () => {
    const b = syncBadge(st({ state: "offline", pending: 2, error: "timeout" }));
    expect(b).toMatchObject({ text: "远端未同步", busy: false });
    expect(b?.tip).toContain("timeout");
    expect(b?.tip).toContain("2 项");
  });

  test("已一致但有另存的远端副本：提示并列出路径；离线优先于它", () => {
    const asides = ["/p/.canvas/a.remote-1.md"];
    const b = syncBadge(st({ asides }));
    expect(b?.text).toBe("远端有 1 份改动已另存");
    expect(b?.tip).toContain(asides[0]);
    expect(syncBadge(st({ state: "offline", asides }))?.text).toBe(
      "远端未同步",
    );
  });
});
