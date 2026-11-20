import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import { SessionConfigStore } from "../store/session-configs.js";
import { SessionLibrary } from "./library.js";
import type { SessionPool } from "./pool.js";
import { SessionConfigService } from "./session-config.js";

const stub = await startStub(() => "ok");
afterAll(() => stub.close());

let pool: SessionPool | undefined;
let data: TestData | undefined;

afterEach(() => {
  pool?.dispose();
  data?.close();
  pool = undefined;
  data = undefined;
  stub.requests.length = 0;
});

// 源会话带齐配置：Agent、模式（含当前模式）与会话配置。
async function setup() {
  const d = testData();
  data = d;
  const presets = testPresets(d);
  const configs = new SessionConfigService({
    store: new SessionConfigStore(d.db),
    defaults: d.defaults,
    resolver: { has: () => false } as never,
  });
  const t = testPool(stubSessionFactory(stub), d, {
    configs,
    presetView: presets.view,
    modeView: presets.modeView,
  });
  pool = t.pool;
  const modeId = presets.mode.id;
  const src = await t.pool.create({
    promptPresetId: presets.coder.id,
    modePresetIds: [modeId],
    config: {
      model: { mode: "follow-default" },
      capabilities: null,
      permissionTier: "full",
    },
  });
  t.pool.setActiveMode(src.id, modeId);
  return {
    w: t.pool,
    presets,
    configs,
    lib: new SessionLibrary(t.pool),
    src,
    modeId,
  };
}

describe("刷新上下文（原地）", () => {
  test("同一个会话：历史、标题、配置、模式都不动；不新建会话", async () => {
    const { w, configs, lib, src, modeId } = await setup();
    const entry = w.get(src.id);
    if (!entry) throw new Error("会话不在池里");
    const c = collector();
    const unsub = entry.subscribe(c);
    entry.send("旧的一段对话");
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    unsub();
    const before = lib.list({}).length;
    const storedBefore = configs.stored(src.id);

    const view = await lib.refreshContext(src.id);
    expect(view.id).toBe(src.id);
    expect(lib.list({}).length).toBe(before);
    expect(view).toMatchObject({
      title: "旧的一段对话",
      modePresetIds: [modeId],
      activeModeId: modeId,
    });
    expect((w.history(src.id) ?? []).length).toBe(2);
    expect(configs.stored(src.id)).toEqual(storedBefore);
  });

  test("运行中不动：session_running，会话与历史原样", async () => {
    const { w, lib, src } = await setup();
    const entry = w.get(src.id);
    if (!entry) throw new Error("会话不在池里");
    stub.mode.delayMs = 300;
    entry.send("慢一点");
    await waitFor(() => entry.busy, "进入运行");
    await expect(lib.refreshContext(src.id)).rejects.toMatchObject({
      code: "session_running",
    });
    await waitFor(() => !entry.busy, "运行结束", 10000);
    stub.mode.delayMs = 0;
  });

  test("会话不存在是 not_found", async () => {
    const { lib } = await setup();
    await expect(
      lib.refreshContext("019a0000-0000-7000-8000-000000000001"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
