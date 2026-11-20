// 回放的记录链路：截图失败不记也不抛、挤掉旧步连图片一起删、按根会话归并。
// 全部用假页面与临时目录，不装浏览器。
import { existsSync, readdirSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { BrowserStepStore } from "../../store/browser-steps.js";
import { type Db, openDatabase } from "../../store/db.js";
import {
  cleanupTmpDirs,
  type FakePage,
  makeRegistry,
} from "../pages/testkit.js";
import { FrameStore } from "./frames.js";
import { Replay } from "./replay.js";

afterAll(cleanupTmpDirs);

const setup = (maxSteps?: number) => {
  const h = makeRegistry();
  const db: Db = openDatabase(makeTmpDir("yuanshu-replay-"));
  const steps = new BrowserStepStore(db);
  const dir = `${makeTmpDir("yuanshu-frames-")}/frames`;
  const frames = new FrameStore(dir);
  const replay = new Replay({
    steps,
    frames,
    registry: h.registry,
    rootOf: (s) => h.parents.get(s) ?? s,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
  return { h, db, steps, frames, dir, replay };
};

const openPage = async (
  h: ReturnType<typeof makeRegistry>,
  url = "https://x.test/a",
) => (await h.registry.open({ workspaceKey: "w1", actor: "s1", url })).page;

const input = (pageId: string, over: Record<string, string> = {}) => ({
  sessionId: "s1",
  workspaceKey: "w1",
  pageId,
  tool: "browser_click",
  summary: "点击 e1",
  ...over,
});

test("正常记录：行与图片都在，url / title 来自句柄", async () => {
  const t = setup();
  const page = await openPage(t.h);
  (t.h.ctx("w1").pages[0] as FakePage).setUrl("https://x.test/b", "第二个页面");
  await t.replay.record(input(page.id));

  const steps = t.replay.steps("w1", "s1");
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({
    workspaceKey: "w1",
    sessionId: "s1",
    pageId: page.id,
    tool: "browser_click",
    summary: "点击 e1",
    url: "https://x.test/b",
    title: "第二个页面",
  });
  expect(t.replay.frame("w1", "s1", steps[0]?.id as number)?.toString()).toBe(
    "jpeg",
  );
  expect(t.replay.sessions("w1")).toHaveLength(1);
});

test("子代理的动作记在它的根会话名下", async () => {
  const t = setup();
  const page = await openPage(t.h);
  t.h.parents.set("sub1", "root1");
  await t.replay.record(input(page.id, { sessionId: "sub1" }));
  expect(t.replay.steps("w1", "sub1")).toEqual([]);
  const steps = t.replay.steps("w1", "root1");
  expect(steps.map((s) => s.sessionId)).toEqual(["root1"]);
});

test("休眠页（没有句柄）不记、不抛", async () => {
  const t = setup();
  const page = await openPage(t.h);
  await t.h.registry.sleep(page.id);
  await expect(t.replay.record(input(page.id))).resolves.toBeUndefined();
  expect(t.replay.steps("w1", "s1")).toEqual([]);
  expect(t.replay.sessions("w1")).toEqual([]);
  expect(existsSync(t.dir)).toBe(false);
});

test("截图抛错：不记、不抛、没有残留行或文件", async () => {
  const t = setup();
  const page = await openPage(t.h);
  const fake = t.h.ctx("w1").pages[0] as FakePage;
  fake.screenshot = async () => {
    throw new Error("页面崩了");
  };
  await expect(t.replay.record(input(page.id))).resolves.toBeUndefined();
  expect(t.replay.steps("w1", "s1")).toEqual([]);
  expect(t.replay.sessions("w1")).toEqual([]);
  expect(existsSync(t.dir)).toBe(false);
});

test("超过 maxSteps：最旧的行与图片文件都没了", async () => {
  const t = setup(2);
  const page = await openPage(t.h);
  await t.replay.record(input(page.id, { summary: "第一步" }));
  await t.replay.record(input(page.id, { summary: "第二步" }));
  const second = t.replay.steps("w1", "s1").map((s) => s.id);
  await t.replay.record(input(page.id, { summary: "第三步" }));

  const steps = t.replay.steps("w1", "s1");
  expect(steps.map((s) => s.summary)).toEqual(["第二步", "第三步"]);
  expect(readdirSync(`${t.dir}/s1`).sort()).toEqual(
    steps.map((s) => `${s.id}.jpg`).sort(),
  );
  // 挤掉的那步的图片确实没了
  expect(t.replay.frame("w1", "s1", second[0] as number)).toBeNull();
});

test("frame 对不存在的步、别的工作区、别的会话返回 null", async () => {
  const t = setup();
  const page = await openPage(t.h);
  await t.replay.record(input(page.id));
  const id = t.replay.steps("w1", "s1")[0]?.id as number;
  expect(t.replay.frame("w1", "s1", id)?.toString()).toBe("jpeg");
  expect(t.replay.frame("w1", "s1", id + 100)).toBeNull();
  expect(t.replay.frame("w2", "s1", id)).toBeNull();
  expect(t.replay.frame("w1", "s2", id)).toBeNull();
});

test("removeSession：清行与整个图片目录，别的不动", async () => {
  const t = setup();
  const page = await openPage(t.h);
  await t.replay.record(input(page.id));
  await t.replay.record(input(page.id, { sessionId: "s2" }));
  expect(t.replay.sessions("w1")).toHaveLength(2);

  t.replay.removeSession("s1");
  expect(t.replay.steps("w1", "s1")).toEqual([]);
  expect(existsSync(`${t.dir}/s1`)).toBe(false);
  expect(t.replay.steps("w1", "s2")).toHaveLength(1);
  expect(existsSync(`${t.dir}/s2`)).toBe(true);
});
