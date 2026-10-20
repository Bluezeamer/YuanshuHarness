import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { createServer, type YuanshuServer } from "../server.js";
import type { FactoryOptions, SessionFactory } from "../session/pool.js";
import { DEFAULT_AGENT_ID } from "../store/agents.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

const TOKEN = "t".repeat(40);
let base: string;
let startDir: string;
let server: YuanshuServer | null = null;
let seen: FactoryOptions[] = [];

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-agents-"));
  mkdirSync(path.join(base, "web"));
  writeFileSync(path.join(base, "web", "index.html"), "<!doctype html>");
  startDir = path.join(base, "start");
  mkdirSync(startDir);
  seen = [];
});
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(base, { recursive: true, force: true });
});

async function launch() {
  const inner = stubSessionFactory(stub);
  const sessionFactory: SessionFactory = (o) => {
    seen.push(o);
    return inner(o);
  };
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      token: TOKEN,
      allowCidrs: [],
    },
    { startDir, sessionFactory, webRoot: path.join(base, "web") },
  );
  const addr = await server.start();
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${addr.port}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      json: (text ? JSON.parse(text) : null) as any,
    };
  };
}

describe("提示词块与预览", () => {
  test("内置块与 agent 种子；块 CRUD 的版本递增与校验", async () => {
    const call = await launch();
    const seeded = (await call("GET", "/api/v1/prompt/blocks")).json.blocks;
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    expect(seeded.every((b: any) => b.group === "角色定义")).toBe(true);
    const agents = (await call("GET", "/api/v1/agents")).json.agents;
    expect(agents).toHaveLength(6);
    expect(agents.some((a: any) => a.id === DEFAULT_AGENT_ID)).toBe(true);

    const bad = await call("POST", "/api/v1/prompt/blocks", { name: "x" });
    expect(bad.status).toBe(400);
    const made = await call("POST", "/api/v1/prompt/blocks", {
      name: "术语表",
      group: "团队术语",
      dimension: "领域",
      content: "元枢即 harness。",
    });
    expect(made.status).toBe(201);
    const id = made.json.id;
    // PATCH 不带 dimension 时保留原值。
    const patched = await call("PATCH", `/api/v1/prompt/blocks/${id}`, {
      content: "元枢是常驻 Server。",
    });
    expect(patched.json).toMatchObject({ version: 2, dimension: "领域" });
    expect((await call("DELETE", `/api/v1/prompt/blocks/${id}`)).status).toBe(
      204,
    );
    expect((await call("DELETE", `/api/v1/prompt/blocks/${id}`)).status).toBe(
      404,
    );
  });

  test("预览按 角色 → 全局约定 → 项目约定 → 自定义分组 拼接，并给出各块字数", async () => {
    writeFileSync(path.join(startDir, "AGENTS.md"), "项目内用 pnpm。");
    const call = await launch();
    const custom = (
      await call("POST", "/api/v1/prompt/blocks", {
        name: "术语表",
        group: "团队术语",
        content: "术语 A",
      })
    ).json;
    const role = (await call("GET", "/api/v1/prompt/blocks")).json.blocks[0];
    await call("PUT", "/api/v1/prompt/conventions", {
      content: "全局：简洁。",
    });

    const r = await call("POST", "/api/v1/prompt/preview", {
      promptBlocks: [custom.id, role.id],
    });
    expect(r.status).toBe(200);
    const text: string = r.json.text;
    const at = (s: string) => text.indexOf(s);
    expect(at("全局：简洁。")).toBeGreaterThan(at(role.content.trim()));
    expect(at("项目内用 pnpm。")).toBeGreaterThan(at("全局：简洁。"));
    expect(at("术语 A")).toBeGreaterThan(at("项目内用 pnpm。"));
    expect(r.json.chars).toBe(text.length);
    expect(r.json.parts.find((p: any) => p.id === custom.id).chars).toBe(
      "术语 A".length,
    );

    // workspace 关闭注入后，项目约定不再出现。
    const ws = (await call("GET", "/api/v1/workspaces")).json.workspaces[0];
    await call("PATCH", `/api/v1/workspaces/${ws.id}`, {
      injectConventions: false,
    });
    const off = await call("POST", "/api/v1/prompt/preview", {
      promptBlocks: [role.id],
    });
    expect(off.json.text).not.toContain("项目内用 pnpm。");
  });

  test("预览参数缺失或 agent 不存在时报错", async () => {
    const call = await launch();
    expect((await call("POST", "/api/v1/prompt/preview", {})).status).toBe(400);
    expect(
      (await call("POST", "/api/v1/prompt/preview", { agentId: "nope" }))
        .status,
    ).toBe(404);
  });
});

describe("agent 定义与会话装配", () => {
  test("CRUD、非法能力被拒、默认 agent 与被会话引用的 agent 不可删", async () => {
    const call = await launch();
    const body = {
      name: "只读",
      description: "只能读",
      promptBlocks: [],
      capabilities: [{ kind: "tool", name: "read" }],
    };
    expect(
      (
        await call("POST", "/api/v1/agents", {
          ...body,
          capabilities: [{ kind: "spell", name: "x" }],
        })
      ).status,
    ).toBe(400);
    const made = await call("POST", "/api/v1/agents", body);
    expect(made.status).toBe(201);
    const id = made.json.id;
    expect(
      (await call("PATCH", `/api/v1/agents/${id}`, { name: "只读 2" })).json
        .name,
    ).toBe("只读 2");
    expect(
      (await call("DELETE", `/api/v1/agents/${DEFAULT_AGENT_ID}`)).status,
    ).toBe(400);

    const s = await call("POST", "/api/v1/sessions", { agentId: id });
    expect(s.status).toBe(201);
    expect(s.json.agentId).toBe(id);
    expect((await call("DELETE", `/api/v1/agents/${id}`)).status).toBe(409);
    const listed = (await call("GET", "/api/v1/sessions")).json.sessions;
    expect(listed.find((x: any) => x.id === s.json.id).agentId).toBe(id);
  });

  test("非法模式与不存在的内置工具被拒；工具目录只列真实工具", async () => {
    const call = await launch();
    const base = { name: "x", description: "d", promptBlocks: [] };
    expect(
      (await call("POST", "/api/v1/agents", { ...base, defaultMode: "yolo" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/v1/agents", {
          ...base,
          capabilities: [{ kind: "tool", name: "teleport" }],
        })
      ).status,
    ).toBe(400);
    // skill / MCP 只是引用位，不校验是否存在。
    expect(
      (
        await call("POST", "/api/v1/agents", {
          ...base,
          capabilities: [{ kind: "skill", name: "anything" }],
        })
      ).status,
    ).toBe(201);
    const tools = (await call("GET", "/api/v1/tools")).json.tools;
    expect(tools.map((t: any) => t.name)).toContain("bash");
    expect(tools.find((t: any) => t.name === "write").readOnly).toBe(false);
  });

  test("plan 模式的 agent：会话记下模式，提示词末尾带模式段，预览一致", async () => {
    const call = await launch();
    const plan = (
      await call("POST", "/api/v1/agents", {
        name: "规划",
        description: "d",
        promptBlocks: [],
        defaultMode: "plan",
      })
    ).json;
    const s = (await call("POST", "/api/v1/sessions", { agentId: plan.id }))
      .json;
    expect(s.mode).toBe("plan");
    expect(seen.at(-1)?.agent?.promptText()).toContain("plan 模式");

    const build = (await call("POST", "/api/v1/sessions", {})).json;
    expect(build.mode).toBe("build");
    expect(seen.at(-1)?.agent?.promptText()).not.toContain("plan 模式");

    const byAgent = await call("POST", "/api/v1/prompt/preview", {
      agentId: plan.id,
    });
    expect(byAgent.json.parts.at(-1).kind).toBe("mode");
    const byBlocks = await call("POST", "/api/v1/prompt/preview", {
      promptBlocks: [],
      mode: "plan",
    });
    expect(byBlocks.json.text).toBe(byAgent.json.text);
    expect(
      (
        await call("POST", "/api/v1/prompt/preview", {
          promptBlocks: [],
          mode: "yolo",
        })
      ).status,
    ).toBe(400);
  });

  test("会话创建：缺省用默认 agent，未知 agent 报 400", async () => {
    const call = await launch();
    const s = await call("POST", "/api/v1/sessions", {});
    expect(s.json.agentId).toBe(DEFAULT_AGENT_ID);
    expect(
      (await call("POST", "/api/v1/sessions", { agentId: "nope" })).status,
    ).toBe(400);
  });

  test("工厂拿到工具白名单（含 ask_user）和组装好的提示词；同步后提示词更新", async () => {
    const call = await launch();
    const block = (
      await call("POST", "/api/v1/prompt/blocks", {
        name: "角色",
        group: "角色定义",
        content: "第一版角色",
      })
    ).json;
    const agent = (
      await call("POST", "/api/v1/agents", {
        name: "只读",
        description: "d",
        promptBlocks: [block.id],
        capabilities: [{ kind: "tool", name: "read" }],
      })
    ).json;
    const s = (await call("POST", "/api/v1/sessions", { agentId: agent.id }))
      .json;
    const fa = seen.at(-1)?.agent;
    expect(fa?.tools).toEqual(["read", "ask_user"]);
    expect(fa?.promptText()).toContain("第一版角色");

    // 块被引用而非复制：更新后会话在同步前仍是旧版本。
    await call("PATCH", `/api/v1/prompt/blocks/${block.id}`, {
      content: "第二版角色",
    });
    expect(fa?.promptText()).toContain("第一版角色");
    const sync = await call("POST", `/api/v1/sessions/${s.id}/prompt/sync`);
    expect(sync.json.result).toBe("synced");
    expect(fa?.promptText()).toContain("第二版角色");
    expect(
      (await call("POST", `/api/v1/sessions/${s.id}/prompt/sync`)).json.result,
    ).toBe("unchanged");
    expect((await call("POST", "/api/v1/prompt/sync")).json).toMatchObject({
      synced: 0,
    });
  });
});
