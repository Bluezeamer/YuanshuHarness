// 两份真 AGENTS.md 进系统提示词：顺序、按主目录读、只在基线上读（创建 / 装载 / 重建）。
// 真实会话池 + 真实会话工厂 + OpenAI 兼容 stub；ysHome 一律是临时目录。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import { spawnChild, subagentWorld } from "../../test/support/subagents.js";
import { LocalEnv } from "../env/local.js";
import { PromptCardStore } from "../store/prompt-cards.js";
import { PromptPresetStore } from "../store/prompt-presets.js";
import { AGENTS_FILE, readAgentsFiles } from "./agents-md.js";
import { promptSlotsOf } from "./delivery.js";
import { SessionLibrary } from "./library.js";
import type { SessionPool } from "./pool.js";
import { modeViewOf, selectPresets } from "./preset-selection.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base = "";
let ysHome = "";
let pool: SessionPool | undefined;
let data: TestData | undefined;

afterEach(() => {
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
  stub.requests.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
  ysHome = "";
});

// 每个用例一个临时根：ysHome 与项目目录都在里面。
function freshBase(): void {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-agents-files-"));
  ysHome = path.join(base, "ys");
  mkdirSync(ysHome);
}

function makeDir(name: string, agents?: string) {
  const p = path.join(base, name);
  mkdirSync(p, { recursive: true });
  if (agents !== undefined) writeFileSync(path.join(p, AGENTS_FILE), agents);
  return p;
}

function boot(dir?: string, seed = true) {
  const d = testData(dir);
  const presets = seed
    ? testPresets(d)
    : presetSelectors(new PromptCardStore(d.db), new PromptPresetStore(d.db));
  const t = testPool(stubSessionFactory(stub), d, {
    presetView: presets.view,
    modeView: presets.modeView,
    // 与生产接线同一份读法：主目录所在环境（测试里都是本机）。
    agentsFiles: (id) => {
      const ws = d.directories.get(id);
      return readAgentsFiles(
        ysHome,
        ws ? { env: new LocalEnv(), root: ws.path } : null,
      );
    },
  });
  pool = t.pool;
  data = d;
  return { pool: t.pool, data: d, presets };
}

async function run(p: SessionPool, id: string) {
  const e = p.get(id);
  if (!e) throw new Error("会话不在池里");
  const c = collector();
  e.subscribe(c);
  e.send("go");
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
  return c;
}

type Harness = ReturnType<typeof boot>;

// 重启后沿用库里已有的预设，不再插种子。
function presetSelectors(cards: PromptCardStore, presets: PromptPresetStore) {
  return {
    cards,
    presets,
    view: (choice: Parameters<typeof selectPresets>[2]) =>
      selectPresets(presets, cards, choice),
    modeView: (id: string) => modeViewOf(presets, cards, id),
  };
}

// 最近一次模型请求里的 system 文本
const systemOfLast = (): string => {
  const body = stub.requests.at(-1)?.body as {
    messages: { role: string; content: unknown }[];
  };
  const sys = body.messages.find(
    (m) => m.role === "system" || m.role === "developer",
  );
  return typeof sys?.content === "string"
    ? sys.content
    : JSON.stringify(sys?.content ?? "");
};

// 造一份激活的全局附加提示词（正文来自一张卡片）
function activeExtra(h: Harness, body: string): void {
  const { cards, presets } = h.presets;
  const preset = presets.create({ kind: "global-extra", name: "附加" });
  const card = cards.create({ group: "附加", title: "附加", body });
  presets.replaceNodes(preset.id, [
    {
      id: `${preset.id}-root`,
      tag: null,
      title: "附加提示词正文",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      items: [{ kind: "card", cardId: card.id }],
    },
  ]);
  presets.activate(preset.id);
}

test("建会话：三段依次是 global_agentsmd、global_extra、project_agentsmd", async () => {
  freshBase();
  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局暗号");
  const h = boot();
  const dir = makeDir("proj", "项目暗号");
  const ws = h.data.directories.create("proj", dir);
  if (!ws) throw new Error("directory 没建成");
  activeExtra(h, "附加暗号");

  const s = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, s.id);
  const sys = systemOfLast();
  expect(sys).toContain("<global_agentsmd>");
  expect(sys).toContain("全局暗号");
  expect(sys).toContain("<global_extra>");
  expect(sys).toContain("附加暗号");
  expect(sys).toContain("<project_agentsmd>");
  expect(sys).toContain("项目暗号");
  const at = (tag: string) => sys.indexOf(`<${tag}>`);
  expect(at("global_agentsmd")).toBeLessThan(at("global_extra"));
  expect(at("global_extra")).toBeLessThan(at("project_agentsmd"));
});

test("只有全局文件 / 只有项目文件 / 都没有", async () => {
  freshBase();
  const dir = makeDir("proj");
  const h = boot();
  const ws = h.data.directories.create("proj", dir);
  if (!ws) throw new Error("directory 没建成");
  const global = path.join(ysHome, "AGENTS.md");

  writeFileSync(global, "只有全局");
  const onlyGlobal = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, onlyGlobal.id);
  expect(systemOfLast()).toContain("<global_agentsmd>");
  expect(systemOfLast()).not.toContain("<project_agentsmd>");

  rmSync(global);
  writeFileSync(path.join(dir, AGENTS_FILE), "只有项目");
  const onlyProject = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, onlyProject.id);
  expect(systemOfLast()).toContain("<project_agentsmd>");
  expect(systemOfLast()).not.toContain("<global_agentsmd>");

  rmSync(path.join(dir, AGENTS_FILE));
  const neither = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, neither.id);
  expect(systemOfLast()).not.toContain("<global_agentsmd>");
  expect(systemOfLast()).not.toContain("<project_agentsmd>");
});

test("运行中改文件：当前会话不变，rebase 之后变成新内容", async () => {
  freshBase();
  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局第一版");
  const dir = makeDir("proj", "项目第一版");
  const h = boot();
  const ws = h.data.directories.create("proj", dir);
  if (!ws) throw new Error("directory 没建成");

  const s = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, s.id);
  expect(systemOfLast()).toContain("全局第一版");
  expect(systemOfLast()).toContain("项目第一版");

  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局第二版");
  writeFileSync(path.join(dir, AGENTS_FILE), "项目第二版");
  await run(h.pool, s.id);
  // 每次运行都重读就不是基线了：第二次请求仍是第一版
  expect(systemOfLast()).toContain("全局第一版");
  expect(systemOfLast()).toContain("项目第一版");
  expect(h.pool.get(s.id)?.promptText).toContain("项目第一版");

  expect(await h.pool.rebase(s.id)).toBe("synced");
  expect(h.pool.get(s.id)?.promptText).toContain("全局第二版");
  expect(h.pool.get(s.id)?.promptText).toContain("项目第二版");
  await run(h.pool, s.id);
  expect(systemOfLast()).toContain("项目第二版");
});

test("重启后装载的会话仍带着文件内容", async () => {
  freshBase();
  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局约定");
  const dir = makeDir("proj", "项目约定");
  const h = boot();
  const ws = h.data.directories.create("proj", dir);
  if (!ws) throw new Error("directory 没建成");
  const s = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, s.id);

  // 服务停着时改了文件：装载会重读（存到会话上），提示词基线到期靠重建带上
  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局约定·改");
  h.pool.dispose();
  h.data.close(false);
  const again = boot(h.data.dir, false);
  const e = await again.pool.acquire(s.id);
  expect(e?.agentsFiles).toEqual({
    global: "全局约定·改",
    project: "项目约定",
  });
  expect(e?.promptText).toContain("全局约定");
  expect(e?.promptText).not.toContain("全局约定·改");
  expect(e?.promptText).toContain("项目约定");
  expect(await again.pool.rebase(s.id)).toBe("synced");
  expect(again.pool.get(s.id)?.promptText).toContain("全局约定·改");
  await run(again.pool, s.id);
  expect(systemOfLast()).toContain("全局约定·改");
  expect(systemOfLast()).toContain("项目约定");
});

test("会话切到了附加目录：重启装载、重建基线读的仍是主目录的项目文件", async () => {
  freshBase();
  const primary = makeDir("primary", "主目录约定");
  const other = makeDir("other", "附加目录约定");
  const h = boot();
  const a = h.data.directories.create("primary", primary);
  const b = h.data.directories.create("other", other);
  if (!a || !b) throw new Error("directory 没建成");
  const s = await h.pool.create({ directoryIds: [a.id, b.id] });
  await run(h.pool, s.id);

  // 模拟 switch_directory：条目与索引里的「当前目录」换成附加目录
  const entry = h.pool.get(s.id);
  if (!entry) throw new Error("会话不在池里");
  entry.directoryId = b.id;
  h.data.store.updateDirectoryId(s.id, b.id);
  h.pool.dispose();
  h.data.close(false);

  const again = boot(h.data.dir, false);
  const loaded = await again.pool.acquire(s.id);
  expect(loaded?.directoryId).toBe(b.id);
  expect(loaded?.agentsFiles.project).toBe("主目录约定");
  writeFileSync(path.join(primary, AGENTS_FILE), "主目录约定·改");
  await again.pool.rebase(s.id);
  expect(again.pool.get(s.id)?.agentsFiles.project).toBe("主目录约定·改");
});

test("刷新上下文（原地）读到文件的新内容：同一个会话，下一次发给模型的开头系统消息换成新版，历史还在", async () => {
  freshBase();
  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局旧版");
  const dir = makeDir("proj", "项目旧版");
  const h = boot();
  const ws = h.data.directories.create("proj", dir);
  if (!ws) throw new Error("directory 没建成");
  const s = await h.pool.create({ directoryIds: [ws.id] });
  const entry = h.pool.get(s.id);
  if (!entry) throw new Error("会话不在池里");
  const c = collector();
  entry.subscribe(c);
  const say = async (text: string) => {
    c.frames.length = 0;
    stub.requests.length = 0;
    entry.send(text);
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    return JSON.stringify(stub.requests.at(-1)?.body);
  };
  const first = await say("one");
  expect(first).toContain("全局旧版");
  expect(first).toContain("项目旧版");

  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局新版");
  writeFileSync(path.join(dir, AGENTS_FILE), "项目新版");
  const view = await new SessionLibrary(h.pool).refreshContext(s.id);
  expect(view.id).toBe(s.id);
  expect(h.pool.get(s.id)?.promptText).toContain("全局新版");
  expect(h.pool.get(s.id)?.promptText).toContain("项目新版");

  const second = await say("two");
  expect(second).toContain("全局新版");
  expect(second).toContain("项目新版");
  expect(second).not.toContain("全局旧版");
  expect(second).not.toContain("项目旧版");
  // 历史没丢：上一轮的对话还在发给模型的消息里
  expect(second).toContain("one");
  expect(second).toContain("reply-1");
});

test("子代理的项目文件来自它自己的主目录", async () => {
  freshBase();
  const a = makeDir("alpha", "甲项目暗号");
  const b = makeDir("beta", "乙项目暗号");
  const w = subagentWorld(stub, {
    deps: (d) => ({
      agentsFiles: (id) => {
        const ws = d.directories.get(id);
        return readAgentsFiles(
          ysHome,
          ws ? { env: new LocalEnv(), root: ws.path } : null,
        );
      },
    }),
  });
  try {
    const wa = w.data.directories.create("alpha", a);
    const wb = w.data.directories.create("beta", b);
    if (!wa || !wb) throw new Error("directory 没建成");
    const parent = await w.pool.create({ directoryIds: [wa.id, wb.id] });
    w.pool.get(parent.id)?.send("go");

    const { childId, done } = await spawnChild(w, parent.id, {
      task: "看一眼乙",
      directory: `local:${wb.name}`,
    });
    done.catch(() => {});
    for (let i = 0; i < 100; i++) {
      const e = w.pool.get(childId);
      if (e?.promptText?.includes("<project_agentsmd>")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const childText = w.pool.get(childId)?.promptText ?? "";
    expect(childText).toContain("乙项目暗号");
    expect(childText).not.toContain("甲项目暗号");
  } finally {
    await w.close();
  }
});

test("三段不进状态映射：改文件不产生状态通知", async () => {
  freshBase();
  writeFileSync(path.join(ysHome, "AGENTS.md"), "全局暗号");
  const dir = makeDir("proj", "项目暗号");
  const h = boot();
  const ws = h.data.directories.create("proj", dir);
  if (!ws) throw new Error("directory 没建成");
  const s = await h.pool.create({ directoryIds: [ws.id] });
  await run(h.pool, s.id);

  const render = h.pool.get(s.id)?.promptRender;
  const slots = promptSlotsOf(render ?? null);
  expect(slots.global_agentsmd).toBeUndefined();
  expect(slots.project_agentsmd).toBeUndefined();
  expect(slots.global_extra).toBeUndefined();

  writeFileSync(path.join(dir, AGENTS_FILE), "项目暗号改过");
  const c = await run(h.pool, s.id);
  const users = c.frames
    .filter((f) => f.type === "message.ended")
    .map((f) => JSON.stringify(f.data))
    .join("\n");
  expect(users).not.toContain("System state update");
});
