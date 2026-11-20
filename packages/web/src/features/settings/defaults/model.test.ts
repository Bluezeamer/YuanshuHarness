import { expect, test } from "vitest";
import {
  CANVAS_MEDIA_DEFAULT,
  type Defaults,
  PI_IMAGE_COMPRESSION,
} from "../../../api/defaults";
import {
  changesOf,
  errorsOf,
  formOf,
  levelOptions,
  settle,
  startupLevel,
} from "./model";
import { custom, model, PI_AGENT_DEFAULTS } from "./testkit";

const noLow = model("m-nolow", {
  reasoning: true,
  levels: ["off", "medium", "high"],
});
const withLow = model("m-low", {
  reasoning: true,
  levels: ["off", "minimal", "low", "high"],
});

test("startupLevel：不能思考为 off，有 low 取 low，没有 low 取第二档", () => {
  expect(startupLevel(model("p"))).toBe("off");
  expect(startupLevel(withLow)).toBe("low");
  expect(startupLevel(noLow)).toBe("medium");
});

test("levelOptions：「关闭」永远在，其余按模型声明、按固定顺序", () => {
  expect(levelOptions(noLow)).toEqual(["off", "medium", "high"]);
  expect(levelOptions(model("p"))).toEqual(["off"]);
});

test("settle：换供应商落到它的第一个模型；当前档位仍被支持就保留，否则取启动档位", () => {
  const list = [
    custom("a", { models: [withLow, noLow] }),
    custom("b", { models: [model("b1"), noLow] }),
  ];
  expect(settle(list, "a", { thinking: "high" })).toEqual({
    provider: "a",
    model: "m-low",
    thinking: "high",
  });
  expect(settle(list, "b", { thinking: "high" })).toEqual({
    provider: "b",
    model: "b1",
    thinking: "off",
  });
  expect(settle(list, "a", { model: "m-nolow", thinking: "low" })).toEqual({
    provider: "a",
    model: "m-nolow",
    thinking: "medium",
  });
  // 没有现成档位（null）：用启动档位
  expect(settle(list, "a", { thinking: null }).thinking).toBe("low");
});

test("settle：刚换了模型就落在它声明的默认档位；只改档位时不动用户的选择", () => {
  const dflt = model("m-dflt", {
    reasoning: true,
    levels: ["off", "low", "medium", "high"],
    defaultLevel: "high",
  });
  const list = [custom("a", { models: [withLow, dflt] })];
  expect(
    settle(list, "a", { model: "m-dflt", thinking: "low", fresh: true }),
  ).toEqual({ provider: "a", model: "m-dflt", thinking: "high" });
  expect(
    settle(list, "a", { model: "m-dflt", thinking: "low", fresh: false }),
  ).toEqual({ provider: "a", model: "m-dflt", thinking: "low" });
  // 没声明默认档位的模型照旧：保留当前档位
  expect(
    settle(list, "a", { model: "m-low", thinking: "high", fresh: true }),
  ).toEqual({ provider: "a", model: "m-low", thinking: "high" });
});

const defaults: Defaults = {
  directoryStart: "~",
  imageCompression: PI_IMAGE_COMPRESSION,
  permissionTier: "rules",
  reviewModel: null,
  auxModel: null,
  jobRemindSeconds: 600,
  goalMaxRounds: 50,
  subagentLimits: { maxDepth: 3, perCaller: 10, perTree: 50 },
  canvasMedia: CANVAS_MEDIA_DEFAULT,
  browserMirror: "",
};
const piOnly = {
  file: "/data/ys/settings.json",
  values: { compaction: {}, retry: {} },
  problems: [],
  defaults: PI_AGENT_DEFAULTS,
};
const saved = formOf(null, defaults, piOnly);

test("formOf：秒换成分钟、字节换成 KiB，数字都存成文字", () => {
  expect(saved).toMatchObject({
    remindMin: "10",
    goalUnlimited: false,
    goalRounds: "50",
    maxKiB: "4608",
    maxWidth: "2000",
    perTree: "50",
    start: "~",
  });
});

test("formOf：目标不限轮数（null）→ 开关关、数字回到 50", () => {
  const f = formOf(null, { ...defaults, goalMaxRounds: null }, piOnly);
  expect(f).toMatchObject({ goalUnlimited: true, goalRounds: "50" });
});

test("changesOf / errorsOf：目标轮数上限——改数字、切不限、不限时不校验也不发数字", () => {
  expect(changesOf({ ...saved, goalRounds: "20" }, saved).defaults).toEqual({
    goalMaxRounds: 20,
  });
  expect(changesOf({ ...saved, goalUnlimited: true }, saved).defaults).toEqual({
    goalMaxRounds: null,
  });
  const unlimited = { ...saved, goalUnlimited: true };
  // 不限时数字框里留着什么都不管
  expect(errorsOf({ ...unlimited, goalRounds: "乱写" })).toEqual({});
  expect(
    changesOf({ ...unlimited, goalRounds: "7" }, unlimited).defaults,
  ).toEqual({});
  // 从不限切回有限：用框里的数字
  expect(
    changesOf(
      { ...unlimited, goalUnlimited: false, goalRounds: "7" },
      unlimited,
    ).defaults,
  ).toEqual({ goalMaxRounds: 7 });
  expect(errorsOf({ ...saved, goalRounds: "0" })).toEqual({
    goalRounds: "轮数上限要是 1–10000 的整数",
  });
});

test("formOf：压缩与重试文件里没写的项显示 pi 自己的值，写了的以文件为准", () => {
  expect(saved).toMatchObject({
    compactOn: true,
    compactReserve: "16384",
    compactKeep: "20000",
    retryOn: true,
    retryMax: "3",
  });
  const filed = formOf(null, defaults, {
    ...piOnly,
    values: {
      compaction: { enabled: false, reserveTokens: 32768 },
      retry: { maxRetries: 0 },
    },
  });
  expect(filed).toMatchObject({
    compactOn: false,
    compactReserve: "32768",
    compactKeep: "20000",
    retryOn: true,
    retryMax: "0",
  });
});

test("changesOf：没改什么就什么都不发；改一项只发那一个分区，图片压缩与子代理限额整组发", () => {
  expect(changesOf(saved, saved)).toEqual({ model: null, defaults: {} });
  expect(
    changesOf({ ...saved, remindMin: "30", start: " /srv " }, saved),
  ).toEqual({
    model: null,
    defaults: { jobRemindSeconds: 1800, directoryStart: "/srv" },
  });
  expect(changesOf({ ...saved, maxKiB: "1024" }, saved).defaults).toEqual({
    imageCompression: { ...PI_IMAGE_COMPRESSION, maxBytes: 1024 * 1024 },
  });
  expect(changesOf({ ...saved, perCaller: "4" }, saved).defaults).toEqual({
    subagentLimits: { maxDepth: 3, perCaller: 4, perTree: 50 },
  });
  expect(changesOf({ ...saved, gifMB: "30" }, saved).defaults).toEqual({
    canvasMedia: { ...CANVAS_MEDIA_DEFAULT, gifMaxMB: 30 },
  });
  const pick = { provider: "a", model: "m", thinking: "low" as const };
  expect(changesOf({ ...saved, model: pick }, saved).model).toEqual(pick);
});

test("errorsOf：压缩与重试的数字按服务端范围拦；重试次数 0 合法", () => {
  expect(errorsOf({ ...saved, retryMax: "0" })).toEqual({});
  expect(
    errorsOf({
      ...saved,
      compactReserve: "100",
      compactKeep: "x",
      retryMax: "11",
    }),
  ).toEqual({
    compactReserve: "预留余量要是 4096–65536 的整数",
    compactKeep: "保留最近要是 4000–200000 的整数",
    retryMax: "重试次数要是 0–10 的整数",
  });
});

test("errorsOf：越界和非整数都点名那一项，起点不能为空；没毛病是空对象", () => {
  expect(errorsOf(saved)).toEqual({});
  expect(
    errorsOf({ ...saved, maxWidth: "99", remindMin: "1.5", start: " " }),
  ).toEqual({
    maxWidth: "最大宽度要是 256–2000 的整数",
    remindMin: "提醒间隔要是 1–1440 的整数",
    start: "起点不能为空",
  });
  expect(errorsOf({ ...saved, thumbSide: "100", uploadMB: "0" })).toEqual({
    thumbSide: "缩略图最长边要是 256–4096 的整数",
    uploadMB: "单个文件上限要是 1–4096 的整数",
  });
});
