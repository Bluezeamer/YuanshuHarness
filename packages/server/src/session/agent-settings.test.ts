import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import {
  AGENT_SETTINGS_RANGE,
  AgentSettingsError,
  AgentSettingsFile,
  overlayAgentSettings,
} from "./agent-settings.js";

// 读配置文件的次数：只统计我们那个文件（过滤掉 SDK 读它自己 settings.json 的那些）。
const counters = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((
      file: Parameters<typeof actual.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      counters.paths.push(String(file));
      return (actual.readFileSync as (...args: unknown[]) => unknown)(
        file,
        ...rest,
      );
    }) as typeof actual.readFileSync,
  };
});

const BAD_JSON = "settings.json 不是合法的 JSON，已忽略";
const EMPTY = { compaction: {}, retry: {} };

/** `<ysHome>/settings.json` 的路径与读它的次数 */
function target(): { file: string; reads: () => number } {
  const dir = join(makeTmpDir("b24-settings-"), "nested");
  const file = join(dir, "settings.json");
  mkdirSync(dir);
  return { file, reads: () => counters.paths.filter((p) => p === file).length };
}

const write = (file: string, body: unknown) =>
  writeFileSync(file, JSON.stringify(body));

test("文件不存在：全是空值，没有问题", () => {
  const { file } = target();
  expect(new AgentSettingsFile(file).read()).toEqual({
    values: EMPTY,
    problems: [],
  });
});

test("坏 JSON：忽略内容并记一句，文件原样保留", () => {
  const { file } = target();
  writeFileSync(file, '{"compaction": ');
  const out = new AgentSettingsFile(file).read();
  expect(out).toEqual({ values: EMPTY, problems: [BAD_JSON] });
  expect(readFileSync(file, "utf8")).toBe('{"compaction": ');
});

test("根不是对象：按坏 JSON 处理", () => {
  const { file } = target();
  write(file, [1, 2]);
  expect(new AgentSettingsFile(file).read().problems).toEqual([BAD_JSON]);
});

test("单项类型不对 / 超出范围：只忽略这一项并说清键名与原因", () => {
  const { file } = target();
  write(file, {
    compaction: {
      enabled: "yes",
      reserveTokens: 4095,
      keepRecentTokens: 12345,
    },
    retry: { enabled: true, maxRetries: 11 },
  });
  const out = new AgentSettingsFile(file).read();
  expect(out.values).toEqual({
    compaction: { keepRecentTokens: 12345 },
    retry: { enabled: true },
  });
  expect(out.problems).toEqual([
    "settings.json 里的 compaction.enabled 无效（必须是 true 或 false），已忽略",
    "settings.json 里的 compaction.reserveTokens 无效（必须是 4096–65536 的整数），已忽略",
    "settings.json 里的 retry.maxRetries 无效（必须是 0–10 的整数），已忽略",
  ]);
});

test("分组不是对象：整组忽略", () => {
  const { file } = target();
  write(file, { compaction: 3, retry: { enabled: false } });
  expect(new AgentSettingsFile(file).read()).toEqual({
    values: { compaction: {}, retry: { enabled: false } },
    problems: ["settings.json 里的 compaction 不是对象，已忽略"],
  });
});

test("范围边界值本身合法", () => {
  const { file } = target();
  const { reserveTokens, keepRecentTokens, maxRetries } = AGENT_SETTINGS_RANGE;
  write(file, {
    compaction: {
      enabled: false,
      reserveTokens: reserveTokens.min,
      keepRecentTokens: keepRecentTokens.max,
    },
    retry: { maxRetries: maxRetries.min },
  });
  expect(new AgentSettingsFile(file).read()).toEqual({
    values: {
      compaction: {
        enabled: false,
        reserveTokens: reserveTokens.min,
        keepRecentTokens: keepRecentTokens.max,
      },
      retry: { maxRetries: maxRetries.min },
    },
    problems: [],
  });
});

test("不认识的键不报问题、也不丢", () => {
  const { file } = target();
  write(file, { retry: { enabled: true, baseDelayMs: 500 }, custom: { x: 1 } });
  const settings = new AgentSettingsFile(file);
  expect(settings.read().problems).toEqual([]);
  settings.update({ retry: { maxRetries: 2 } });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    retry: { enabled: true, baseDelayMs: 500, maxRetries: 2 },
    custom: { x: 1 },
  });
});

test("按 mtime 缓存：文件没动不重读，动了下次读到新值", () => {
  const { file, reads } = target();
  write(file, { compaction: { reserveTokens: 8000 } });
  const settings = new AgentSettingsFile(file);
  expect(settings.read().values.compaction.reserveTokens).toBe(8000);
  expect(reads()).toBe(1);
  expect(settings.read().values.compaction.reserveTokens).toBe(8000);
  expect(reads()).toBe(1);
  // 内容长度也变了：同一毫秒内的等长改写落在文件系统的时间戳粒度之内，认不出来
  write(file, { compaction: { reserveTokens: 32000 } });
  expect(settings.read().values.compaction.reserveTokens).toBe(32000);
  expect(reads()).toBe(2);
});

test("update：合并写、缩进 2 空格、末尾换行", () => {
  const { file } = target();
  write(file, { compaction: { enabled: true } });
  const out = new AgentSettingsFile(file).update({
    compaction: { reserveTokens: 16384 },
    retry: { maxRetries: 0 },
  });
  expect(out.values).toEqual({
    compaction: { enabled: true, reserveTokens: 16384 },
    retry: { maxRetries: 0 },
  });
  expect(readFileSync(file, "utf8")).toBe(
    `${JSON.stringify(
      {
        compaction: { enabled: true, reserveTokens: 16384 },
        retry: { maxRetries: 0 },
      },
      null,
      2,
    )}\n`,
  );
});

test("update：目录不存在就创建，原子写不留临时文件", () => {
  const dir = join(makeTmpDir("b24-settings-"), "nested", "deeper");
  const file = join(dir, "settings.json");
  const settings = new AgentSettingsFile(file);
  settings.update({ retry: { enabled: false } });
  expect(readdirSync(dir)).toEqual(["settings.json"]);
});

test("update：null 删掉这一项，删空的分组整组删掉", () => {
  const { file } = target();
  write(file, {
    compaction: { enabled: true, reserveTokens: 8000 },
    retry: { enabled: true, maxRetries: 3 },
  });
  const settings = new AgentSettingsFile(file);
  settings.update({ compaction: { reserveTokens: null } });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });
  settings.update({
    compaction: { enabled: null },
    retry: { enabled: null, maxRetries: null },
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  expect(settings.read().values).toEqual(EMPTY);
});

test("update：什么补丁都不带时写出一份合法的空对象", () => {
  const { file } = target();
  const settings = new AgentSettingsFile(file);
  expect(settings.update({}).values).toEqual(EMPTY);
  expect(readFileSync(file, "utf8")).toBe("{}\n");
});

test("update：原文件坏掉时拒绝，文件字节不变", () => {
  const { file } = target();
  writeFileSync(file, '{"retry":');
  const settings = new AgentSettingsFile(file);
  expect(() => settings.update({ retry: { maxRetries: 1 } })).toThrow(
    AgentSettingsError,
  );
  expect(() => settings.update({ retry: { maxRetries: 1 } })).toThrow(
    "settings.json 现在不是合法 JSON，先改好再从界面保存",
  );
  expect(readFileSync(file, "utf8")).toBe('{"retry":');
});

test("update：任何一项不合法就整个补丁不写", () => {
  const { file } = target();
  write(file, { retry: { maxRetries: 3 } });
  const before = statSync(file).mtimeMs;
  const settings = new AgentSettingsFile(file);
  expect(() =>
    settings.update({ retry: { enabled: false, maxRetries: 11 } }),
  ).toThrow("retry.maxRetries 必须是 0–10 的整数");
  expect(() =>
    settings.update({ compaction: { reserveTokens: 4096.5 } }),
  ).toThrow("compaction.reserveTokens 必须是 4096–65536 的整数");
  expect(() =>
    settings.update({ compaction: { enabled: "true" as never } }),
  ).toThrow("compaction.enabled 必须是 true 或 false");
  expect(() => settings.update({ retry: { nope: 1 } as never })).toThrow(
    "未知的设置项：retry.nope",
  );
  expect(readFileSync(file, "utf8")).toBe('{"retry":{"maxRetries":3}}');
  expect(statSync(file).mtimeMs).toBe(before);
});

test("update：错误带的错误码与状态码", () => {
  const { file } = target();
  try {
    new AgentSettingsFile(file).update({ retry: { maxRetries: 99 } });
    throw new Error("应当抛错");
  } catch (err) {
    expect(err).toBeInstanceOf(AgentSettingsError);
    expect((err as AgentSettingsError).code).toBe("bad_request");
    expect((err as AgentSettingsError).status).toBe(400);
  }
});

// 覆盖：pi 自己那份设置 + 按模型的 override 都写在临时 agentDir 里。
function managers() {
  const piDir = makeTmpDir("b24-pi-");
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: false,
        reserveTokens: 8000,
        keepRecentTokens: 9000,
        modelOverrides: {
          "prov/m1": { reserveTokens: 12000, keepRecentTokens: 13000 },
        },
      },
      retry: { enabled: false, maxRetries: 7, baseDelayMs: 1234 },
    }),
  );
  const manager = SettingsManager.create(makeTmpDir("b24-cwd-"), piDir, {
    projectTrusted: false,
  });
  const file = join(makeTmpDir("b24-ys-"), "settings.json");
  return { manager, file };
}

const MODEL = { provider: "prov", id: "m1" };

test("覆盖：文件没写时五个 getter 都与原值一致", () => {
  const { manager, file } = managers();
  const before = {
    enabled: manager.getCompactionEnabled(),
    reserve: manager.getCompactionReserveTokens(MODEL),
    keep: manager.getCompactionKeepRecentTokens(MODEL),
    settings: manager.getCompactionSettings(MODEL),
    retryEnabled: manager.getRetryEnabled(),
    retry: manager.getRetrySettings(),
  };
  overlayAgentSettings(manager, new AgentSettingsFile(file));
  expect(manager.getCompactionEnabled()).toBe(before.enabled);
  expect(manager.getCompactionReserveTokens(MODEL)).toBe(before.reserve);
  expect(manager.getCompactionKeepRecentTokens(MODEL)).toBe(before.keep);
  expect(manager.getCompactionSettings(MODEL)).toEqual(before.settings);
  expect(manager.getRetryEnabled()).toBe(before.retryEnabled);
  expect(manager.getRetrySettings()).toEqual(before.retry);
});

test("覆盖：文件写了值就以文件为准，三项合成同一份答案", () => {
  const { manager, file } = managers();
  write(file, {
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    },
    retry: { enabled: true, maxRetries: 2 },
  });
  overlayAgentSettings(manager, new AgentSettingsFile(file));
  expect(manager.getCompactionSettings(MODEL)).toEqual({
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  });
  expect(manager.getCompactionEnabled()).toBe(true);
  expect(manager.getCompactionReserveTokens(MODEL)).toBe(16384);
  expect(manager.getCompactionKeepRecentTokens(MODEL)).toBe(20000);
  // 只改 retry 两项，pi 的 baseDelayMs 等仍原样带出
  expect(manager.getRetryEnabled()).toBe(true);
  expect(manager.getRetrySettings()).toEqual({
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 1234,
    maxAgentDelayMs: manager.getRetrySettings().maxAgentDelayMs,
  });
});

test("覆盖：不传模型时也按文件；运行中改文件下一次调用就变，删键回到 pi 的值", () => {
  const { manager, file } = managers();
  write(file, { compaction: { reserveTokens: 20000 } });
  const settings = new AgentSettingsFile(file);
  overlayAgentSettings(manager, settings);
  expect(manager.getCompactionReserveTokens()).toBe(20000);
  // 只写了这一项：其余仍是 pi 的值（含按模型的 override）
  expect(manager.getCompactionSettings(MODEL)).toEqual({
    enabled: false,
    reserveTokens: 20000,
    keepRecentTokens: 13000,
  });
  // 换一个长度不同的值：同一毫秒内的等长改写落在文件系统时间戳的粒度之内
  write(file, { compaction: { reserveTokens: 9000 } });
  expect(manager.getCompactionReserveTokens()).toBe(9000);
  settings.update({ compaction: { reserveTokens: null } });
  expect(manager.getCompactionReserveTokens(MODEL)).toBe(12000);
  expect(manager.getCompactionSettings(MODEL)).toEqual({
    enabled: false,
    reserveTokens: 12000,
    keepRecentTokens: 13000,
  });
});
