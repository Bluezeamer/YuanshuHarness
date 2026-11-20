// 包里的扩展注册的工具（docs/model/plugin.md §3）：白名单不只是内置 + MCP，插件工具也要能用。
// 用真实会话工厂 + 本地目录当包：生产里创建会话会给 pi 一份工具白名单，桩工厂测不到这里。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { collector, type Frame, waitFor } from "../../test/support/frames.js";
import {
  type StubReply,
  startStub,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import { McpRuntime } from "../mcp/runtime.js";
import type { ModelResolver } from "../provider/resolve.js";
import { CapabilityStore } from "../store/capabilities.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { SWITCH_MODE } from "./delivery.js";
import { createSessionFactory } from "./factory.js";
import type { SessionFactory } from "./pool.js";
import { FRAMEWORK_TOOLS, TOOL_NAMES } from "./tool-catalog.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture-resources.mjs", import.meta.url),
);

let script: StubReply[] = [];
const stub = await startStub((n) => script[n - 1] ?? "done");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  script = [];
  stub.requests.length = 0;
});

// 最小 pi 包：pi.extensions 指向一个注册 hello_plugin 的扩展；执行与 session_start 各留一行痕迹。
// 另带一个技能与一个提示词模板：「没打开」要连它们一起挡住，不能只挡扩展。
// 扩展源码逐行拼：结构守卫拦「行首的默认导出写法」，而 pi 要求扩展模块默认导出一个函数。
function makePackage(dir: string, marker: string): string {
  const pkg = path.join(dir, "hello-pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "hello-pkg",
      version: "0.0.1",
      pi: {
        extensions: ["./index.ts"],
        skills: ["./skills"],
        prompts: ["./prompts"],
      },
    }),
  );
  mkdirSync(path.join(pkg, "skills", "pkg-skill"), { recursive: true });
  writeFileSync(
    path.join(pkg, "skills", "pkg-skill", "SKILL.md"),
    "---\nname: pkg-skill\ndescription: 包里带的技能\n---\n正文\n",
  );
  mkdirSync(path.join(pkg, "prompts"), { recursive: true });
  writeFileSync(path.join(pkg, "prompts", "pkg-prompt.md"), "包里带的模板\n");
  writeFileSync(
    path.join(pkg, "index.ts"),
    [
      'import { appendFileSync } from "node:fs";',
      `const log = (line) => appendFileSync(${JSON.stringify(marker)}, line + "\\n");`,
      "const activate = (pi) => {",
      '  pi.on("session_start", (_e, ctx) => {',
      '    log("session:" + ctx.hasUI + ":" + ctx.mode);',
      "  });",
      "  pi.registerTool({",
      '    name: "hello_plugin",',
      '    label: "hello_plugin",',
      '    description: "插件示例工具",',
      '    parameters: { type: "object", properties: {} },',
      "    async execute(_id, _params, _signal, _update, ctx) {",
      '      log("ran");',
      '      ctx.ui.notify("插件提示", "info");',
      "      return {",
      '        content: [{ type: "text", text: "hello from plugin" }],',
      "        details: {},",
      "      };",
      "    },",
      "  });",
      "};",
      "export default activate;",
      "",
    ].join("\n"),
  );
  return pkg;
}

const until = async (cond: () => boolean, what: string, ms = 20000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};

function boot({ withPackage = true, withMcp = false, switchedOn = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-plugin-tools-"));
  const data = testData(path.join(dir, "data"));
  const presets = testPresets(data);
  // 包登记与模型都落在临时 agentDir：工厂按 PI_CODING_AGENT_DIR 取它，不碰真实的 ~/.pi。
  const agentDir = path.join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const marker = path.join(dir, "ran.log");
  const pkg = makePackage(dir, marker);
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: withPackage ? [pkg] : [],
      defaultProvider: "stub",
      defaultModel: "stub-model",
    }),
  );
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-model" }],
        },
      },
    }),
  );
  // 包登记在 pi 的 settings.json 里，会话是否加载它由我们的开关定
  // resolver 返回 null：模型沿用 agentDir 里的 models.json（与之前不传 deps 时一样）
  const real = createSessionFactory({
    resolver: { build: async () => null } as unknown as ModelResolver,
    pluginEnabled: () => new Set(withPackage && switchedOn ? [pkg] : []),
  });
  const sessions = new Map<string, AgentSession>();
  const factory: SessionFactory = async (o) => {
    const s = await real(o);
    sessions.set(o.id, s);
    return s;
  };
  const mcpStore = new McpStore(data.db);
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets: new SecretStore(data.db, loadMasterKey(data.dir)),
    capabilities: new CapabilityStore(data.db),
  });
  if (withMcp) {
    mcpStore.create("fx", {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    });
    mcpStore.patch("fx", { approval: "allow", global: true });
  }
  const t = testPool(factory, data, {
    ...(withMcp ? { mcp } : {}),
    presetView: presets.view,
    modeView: presets.modeView,
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
    () => {
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  );
  const ws = data.directories.create("w", dir, new Date());
  if (!ws) throw new Error("目录没建成");
  const create = (modePresetIds: string[] = []) =>
    t.pool.create({
      directoryIds: [ws.id],
      promptPresetId: presets.coder.id,
      modePresetIds,
    });
  return {
    pool: t.pool,
    sessions,
    create,
    marker,
    presets,
    lines: () => readFileSync(marker, "utf8").split("\n").filter(Boolean),
  };
}

// 发一条消息并跑完；按答案回审批弹窗（缺省拒绝）。
async function run(
  pool: ReturnType<typeof testPool>["pool"],
  id: string,
  text: string,
  answer = "deny",
) {
  const entry = pool.get(id);
  if (!entry) throw new Error("会话不存在");
  // stub 按请求序号取脚本：每一轮都从第 1 条开始。
  stub.requests.length = 0;
  const prompts: Frame[] = [];
  const c = collector((f) => {
    if (f.type === "prompt.requested") {
      prompts.push(f);
      entry.answerPrompt(f.data.promptId, { optionId: answer });
    }
  });
  const off = entry.subscribe(c);
  try {
    entry.send(text);
    await waitFor(
      () => c.types().includes("run.ended") || c.types().includes("run.failed"),
      "run.ended",
      20_000,
    );
  } finally {
    off();
  }
  return { frames: c.frames, prompts };
}

/** 最近一次请求里声明给模型的工具名。 */
const declared = (): string[] =>
  (
    (
      stub.requests.at(-1)?.body as {
        tools?: { function: { name: string } }[];
      }
    )?.tools ?? []
  ).map((t) => t.function.name);

describe("包里的扩展注册的工具", () => {
  test("会话能用上：默认启用、声明给模型、进状态映射、调用时走审批", async () => {
    const b = boot();
    const info = await b.create();
    const s = b.sessions.get(info.id) as AgentSession;
    expect(s.getAllTools().some((t) => t.name === "hello_plugin")).toBe(true);
    expect(s.getActiveToolNames()).toContain("hello_plugin");
    // 打开的是整包：技能和提示词模板也进
    expect(
      s.resourceLoader.getSkills().skills.some((k) => k.name === "pkg-skill"),
    ).toBe(true);
    expect(s.promptTemplates.some((p) => p.name === "pkg-prompt")).toBe(true);

    // 批准之后工具真的执行了
    script = [{ tool: "hello_plugin", args: {} }, "done"];
    const first = await run(b.pool, info.id, "跑一下", "allow");
    expect(declared()).toContain("hello_plugin");
    // 插件工具进状态映射（tools 槽），但不进能力清单：能力目录里没有它
    expect(b.pool.enabledTools(info.id)).toContain("hello_plugin");
    const approval = first.prompts.find((f) => f.data.source === "approval");
    expect(approval?.data.title).toContain("hello_plugin");
    // 扩展在会话创建时收到 session_start：有 UI（rpc 模式），插件的 ctx.ui.* 才会真往前端走
    expect(b.lines()).toContain("session:true:rpc");
    expect(b.lines()).toContain("ran");
    // 插件的单向 UI（notify）真往前端发了：会话快照不存这种瞬时事件，只走事件流
    expect(
      first.frames.some(
        (f) =>
          f.type === "extension.ui" &&
          f.data.method === "notify" &&
          f.data.message === "插件提示",
      ),
    ).toBe(true);
    expect(
      first.frames.some(
        (f) =>
          f.type === "tool.ended" &&
          f.data.output?.includes("hello from plugin"),
      ),
    ).toBe(true);

    // 拒绝就不执行
    script = [{ tool: "hello_plugin", args: {} }, "done"];
    const second = await run(b.pool, info.id, "再来一次", "deny");
    expect(second.prompts.some((f) => f.data.source === "approval")).toBe(true);
    expect(b.lines()).toEqual(["session:true:rpc", "ran"]);
  }, 90_000);

  test("登记了但没打开的包不进会话", async () => {
    const b = boot({ switchedOn: false });
    const info = await b.create();
    const s = b.sessions.get(info.id) as AgentSession;
    expect(s.getAllTools().some((t) => t.name === "hello_plugin")).toBe(false);
    // 扩展没加载，session_start 的痕迹文件也就不会出现
    expect(existsSync(b.marker)).toBe(false);
    // 技能与提示词模板同样不进
    const { skills } = s.resourceLoader.getSkills();
    expect(skills.some((k) => k.name === "pkg-skill")).toBe(false);
    expect(s.promptTemplates.some((p) => p.name === "pkg-prompt")).toBe(false);
  }, 60_000);

  test("模式的限制仍然生效：限定集合里没有它就不启用", async () => {
    const b = boot();
    const info = await b.create([b.presets.mode.id]);
    script = ["done"];
    await run(b.pool, info.id, "先跑一轮", "allow");
    expect(b.pool.enabledTools(info.id)).toContain("hello_plugin");
    // plan 模式只留 read / grep
    b.pool.setActiveMode(info.id, b.presets.mode.id);
    const enabled = b.pool.enabledTools(info.id);
    expect(enabled).not.toContain("hello_plugin");
    expect(enabled).toContain("read");
  }, 90_000);

  // 白名单里有通配 `*`，pi 升级后新增的内置工具会静默混进每个会话：这条在那时变红，提醒补进 EXCLUDED_TOOLS。
  test("没装包时，会话里注册的工具恰好是我们目录里的那些（pi 自带的多余工具已排除）", async () => {
    // 带一个有 resource 的 MCP：pi 的三个 MCP 资源工具只有这时才会注册，不带就测不到它们
    const b = boot({ withPackage: false, withMcp: true });
    const info = await b.create();
    const s = b.sessions.get(info.id) as AgentSession;
    // 资源工具与服务的工具在同一次注册里同步登记：等到服务的工具出现，它们（若没被排除）就已经在了
    await until(
      () => s.getAllTools().some((t) => t.name === "mcp__fx__ping"),
      "MCP 工具注册",
    );
    const ours = new Set([
      ...TOOL_NAMES,
      ...FRAMEWORK_TOOLS.map((t) => t.name),
      SWITCH_MODE,
    ]);
    const extra = s
      .getAllTools()
      .map((t) => t.name)
      .filter((n) => !ours.has(n) && !n.startsWith("mcp__fx__"));
    expect(extra).toEqual([]);
  }, 60_000);
});
