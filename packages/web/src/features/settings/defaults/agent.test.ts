import { expect, test } from "vitest";
import { agentPatchOf, presetFields, presetOf } from "./agent";
import { type DefaultsForm, formOf } from "./model";
import { PI_AGENT_DEFAULTS } from "./testkit";

const base = PI_AGENT_DEFAULTS;
const saved: DefaultsForm = {
  ...formOf(
    null,
    {
      directoryStart: "~",
      imageCompression: {
        enabled: true,
        maxWidth: 2000,
        maxHeight: 2000,
        maxBytes: 4608 * 1024,
        jpegQuality: 80,
      },
      permissionTier: "rules",
      reviewModel: null,
      auxModel: null,
      jobRemindSeconds: 600,
      goalMaxRounds: 50,
      subagentLimits: { maxDepth: 3, perCaller: 10, perTree: 50 },
      canvasMedia: {
        thumbMaxSide: 2000,
        thumbQuality: 85,
        gifMaxMB: 8,
        sourceMaxMB: 20,
        assetGitMaxMB: 5,
        uploadMaxMB: 500,
      },
      browserMirror: "",
    },
    {
      file: "/data/ys/settings.json",
      values: { compaction: {}, retry: {} },
      problems: [],
      defaults: base,
    },
  ),
};

test("presetOf：两个数正好是哪一档就是哪一档，不在任何一档上是自定义", () => {
  expect(presetOf(saved, base)).toBe("default");
  for (const p of ["lean", "detail"] as const)
    expect(presetOf({ ...saved, ...presetFields(p, base) }, base)).toBe(p);
  expect(presetOf({ ...saved, compactKeep: "25000" }, base)).toBeNull();
  // 敲进去的首尾空白不影响判断
  expect(presetOf({ ...saved, compactReserve: " 16384 " }, base)).toBe(
    "default",
  );
});

test("presetFields：「pi 默认」取 pi 此刻的值，不是写死的数", () => {
  const moved = {
    ...base,
    compaction: { ...base.compaction, reserveTokens: 8192 },
  };
  expect(presetFields("default", moved).compactReserve).toBe("8192");
  expect(presetFields("lean", moved).compactReserve).toBe("32768");
});

test("agentPatchOf：没改就是空对象；只带改了的项，同一组里没动的不带", () => {
  expect(agentPatchOf(saved, saved, base)).toEqual({});
  expect(agentPatchOf({ ...saved, compactOn: false }, saved, base)).toEqual({
    compaction: { enabled: false },
  });
  expect(agentPatchOf({ ...saved, retryMax: "5" }, saved, base)).toEqual({
    retry: { maxRetries: 5 },
  });
});

test("agentPatchOf：改回 pi 的值就删掉这一项（null），回到跟随 pi", () => {
  const custom = { ...saved, compactReserve: "32768", retryOn: false };
  expect(
    agentPatchOf({ ...custom, ...presetFields("default", base) }, custom, base),
  ).toEqual({
    compaction: { reserveTokens: null, keepRecentTokens: undefined },
  });
  expect(agentPatchOf({ ...custom, retryOn: true }, custom, base)).toEqual({
    retry: { enabled: null },
  });
});

test("agentPatchOf：选一档预设一次带上两个数", () => {
  expect(
    agentPatchOf({ ...saved, ...presetFields("lean", base) }, saved, base),
  ).toEqual({ compaction: { reserveTokens: 32768, keepRecentTokens: 10000 } });
});
