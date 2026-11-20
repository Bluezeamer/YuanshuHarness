import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  FRAMEWORK_TOOLS,
  TOOL_GROUPS,
  TOOLS,
} from "../session/tool-catalog.js";
import { type Db, openDatabase } from "../store/db.js";
import { ToolRuleStore } from "../store/tool-rules.js";
import { toolsApi } from "./tools.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let rules: ToolRuleStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-"));
  db = openDatabase(dir);
  rules = new ToolRuleStore(db);
  app = Fastify();
  app.register(toolsApi, { rules });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Policy = "allow" | "ask";
type Tool = {
  name: string;
  description: string;
  readOnly: boolean;
  server: boolean;
  group: { key: string; name: string };
  kind: "path" | "flat" | "fixed";
  framework: boolean;
  note: string | null;
  factory: { inside: Policy; outside: Policy } | null;
  rule: { inside: Policy; outside: Policy } | null;
  modified: boolean;
};
const list = async () =>
  (await app.inject({ method: "GET", url: "/api/v1/tools" })).json()
    .tools as Tool[];
const tool = async (name: string) =>
  (await list()).find((t) => t.name === name) as Tool;
const putRule = (name: string, payload: unknown) =>
  app.inject({
    method: "PUT",
    url: `/api/v1/tools/${name}/rule`,
    payload: payload as object,
  });
const putRules = (payload: unknown) =>
  app.inject({
    method: "PUT",
    url: "/api/v1/tools/rules",
    payload: payload as object,
  });
const delRule = (name: string) =>
  app.inject({ method: "DELETE", url: `/api/v1/tools/${name}/rule` });

const GROUP_KEYS = Object.keys(TOOL_GROUPS);

describe("GET /tools", () => {
  test("旧字段保留，目录与框架工具都在", async () => {
    const tools = await list();
    expect(tools.find((t) => t.name === "read")).toMatchObject({
      description: "读取文件",
      readOnly: true,
      server: false,
      group: { key: "files", name: "文件与命令" },
      kind: "path",
      framework: false,
      note: null,
    });
    expect(tools.find((t) => t.name === "write")?.readOnly).toBe(false);
    expect(tools.map((t) => t.name)).toContain("spawn_subagent");
    expect(tools.map((t) => t.name)).toContain("ask_user");
  });

  test("含全部工具：TOOLS + FRAMEWORK_TOOLS，按组顺序排列", async () => {
    const tools = await list();
    expect(tools).toHaveLength(TOOLS.length + FRAMEWORK_TOOLS.length);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...TOOLS, ...FRAMEWORK_TOOLS].map((t) => t.name).sort(),
    );
    const order = tools.map((t) => GROUP_KEYS.indexOf(t.group.key));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 组内保持目录声明顺序
    expect(
      tools.filter((t) => t.group.key === "files").map((t) => t.name),
    ).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "bash",
      "canvas_edit",
    ]);
  });

  test("不再有 powershell / tool_search", async () => {
    const names = (await list()).map((t) => t.name);
    expect(names).not.toContain("powershell");
    expect(names).not.toContain("tool_search");
  });

  test("出厂矩阵：path 7 个、flat 若干，fixed 没有规则", async () => {
    const tools = await list();
    const paths = tools.filter((t) => t.kind === "path");
    expect(paths.map((t) => t.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "bash",
    ]);
    const f = (n: string) => tools.find((t) => t.name === n)?.factory;
    for (const n of ["read", "edit", "write", "grep", "find", "ls"])
      expect(f(n)).toEqual({ inside: "allow", outside: "ask" });
    expect(f("bash")).toEqual({ inside: "ask", outside: "ask" });
    for (const t of tools.filter((x) => x.kind === "flat")) {
      expect(t.factory?.inside).toBe(t.factory?.outside);
      expect(t.rule).toEqual(t.factory);
      expect(t.modified).toBe(false);
    }
    // fixed：不可调，没有出厂值与当前值
    for (const t of tools.filter((x) => x.kind === "fixed"))
      expect(t).toMatchObject({ factory: null, rule: null, modified: false });
    expect(await tool("switch_mode")).toMatchObject({
      kind: "flat",
      factory: { inside: "ask", outside: "ask" },
    });
  });

  test("flat 的出厂值：目录工具与编排默认放行，browser_open / workflow_run 审批", async () => {
    expect((await tool("list_directories")).factory).toEqual({
      inside: "allow",
      outside: "allow",
    });
    expect((await tool("switch_directory")).factory).toEqual({
      inside: "ask",
      outside: "ask",
    });
    expect((await tool("spawn_subagent")).factory).toEqual({
      inside: "allow",
      outside: "allow",
    });
    expect((await tool("workflow_run")).factory).toEqual({
      inside: "ask",
      outside: "ask",
    });
    expect((await tool("browser_open")).factory).toEqual({
      inside: "ask",
      outside: "ask",
    });
    expect((await tool("browser_snapshot")).factory).toEqual({
      inside: "allow",
      outside: "allow",
    });
  });

  test("framework 与 note：固定工具只读展示", async () => {
    const tools = await list();
    expect(
      tools
        .filter((t) => t.framework)
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        "ask_user",
        "call_tool",
        "create_goal",
        "get_goal",
        "job_start",
        "job_list",
        "job_stop",
        "job_remind",
        "deliver",
        "post",
        "switch_mode",
        "todo_write",
        "update_goal",
      ].sort(),
    );
    for (const n of [
      "transfer_files",
      "todo_write",
      "ask_user",
      "call_tool",
      "job_start",
      "deliver",
      "post",
      "get_goal",
      "create_goal",
      "update_goal",
    ])
      expect((await tool(n)).note).toBe(
        n === "transfer_files"
          ? "源端按 read、目标端按 write，各取所在目录的规则"
          : "自身放行",
      );
    // 可调工具没有 note
    for (const n of ["read", "bash", "workflow_run", "switch_mode"])
      expect((await tool(n)).note).toBeNull();
  });
});

describe("PUT / DELETE /tools/:name/rule", () => {
  test("改规则后 rule 变、modified 为真，恢复出厂后归零", async () => {
    const r = await putRule("read", { inside: "ask", outside: "allow" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      name: "read",
      group: { key: "files", name: "文件与命令" },
      kind: "path",
      factory: { inside: "allow", outside: "ask" },
      rule: { inside: "ask", outside: "allow" },
      modified: true,
    });
    expect(await tool("read")).toMatchObject({ modified: true });
    expect(rules.effective("read")).toEqual({
      inside: "ask",
      outside: "allow",
    });
    // 其他工具不受影响
    expect((await tool("ls")).modified).toBe(false);
    const d = await delRule("read");
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({
      rule: { inside: "allow", outside: "ask" },
      modified: false,
    });
    expect(rules.effective("read")).toEqual({
      inside: "allow",
      outside: "ask",
    });
  });

  test("改回出厂值等于恢复出厂（不留覆盖行）", async () => {
    await putRule("bash", { inside: "allow", outside: "allow" });
    const r = await putRule("bash", { inside: "ask", outside: "ask" });
    expect(r.json().modified).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM tool_rules").get()).toEqual({
      n: 0,
    });
  });

  test("flat 工具两格不等：400 且不写", async () => {
    const r = await putRule("spawn_subagent", {
      inside: "ask",
      outside: "allow",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      error: "invalid_rule",
      message: "该工具不分 cwd，inside 与 outside 须相同",
    });
    expect((await tool("spawn_subagent")).modified).toBe(false);
    // 两格相等的 flat 改动正常落库
    const ok = await putRule("switch_directory", {
      inside: "allow",
      outside: "allow",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rule).toEqual({ inside: "allow", outside: "allow" });
  });

  test("fixed 工具与不存在的工具 404", async () => {
    for (const n of [
      "transfer_files",
      "todo_write",
      "ask_user",
      "switch_mode",
    ]) {
      const r = await putRule(n, { inside: "allow", outside: "allow" });
      if (n === "switch_mode") {
        expect(r.statusCode).toBe(200);
        continue;
      }
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe("not_found");
    }
    expect(
      (await putRule("nope", { inside: "allow", outside: "allow" })).statusCode,
    ).toBe(404);
    expect((await delRule("transfer_files")).statusCode).toBe(404);
  });

  test("恢复出厂幂等；参数不合法 400", async () => {
    expect((await delRule("read")).statusCode).toBe(200);
    for (const body of [
      {},
      { inside: "allow" },
      { inside: "allow", outside: "never" },
      { inside: "allow", outside: "deny" },
      { inside: 1, outside: "ask" },
    ])
      expect((await putRule("read", body)).statusCode).toBe(400);
    expect((await tool("read")).modified).toBe(false);
  });
});

describe("PUT /tools/rules（批量，原子）", () => {
  test("全部合格才写；返回全量", async () => {
    const r = await putRules({
      rules: {
        read: { inside: "ask", outside: "ask" },
        list_directories: { inside: "ask", outside: "ask" },
        switch_mode: { inside: "allow", outside: "allow" },
      },
    });
    expect(r.statusCode).toBe(200);
    const tools = r.json().tools as Tool[];
    expect(tools).toHaveLength(TOOLS.length + FRAMEWORK_TOOLS.length);
    const by = (n: string) => tools.find((t) => t.name === n);
    expect(by("read")).toMatchObject({
      rule: { inside: "ask", outside: "ask" },
      modified: true,
    });
    expect(by("list_directories")).toMatchObject({
      rule: { inside: "ask", outside: "ask" },
      modified: true,
    });
    expect(by("switch_mode")).toMatchObject({
      rule: { inside: "allow", outside: "allow" },
      modified: true,
    });
    expect(by("bash")).toMatchObject({ modified: false });
  });

  test("与出厂值相同的项不留行", async () => {
    await putRule("read", { inside: "ask", outside: "ask" });
    const r = await putRules({
      rules: {
        read: { inside: "allow", outside: "ask" },
        bash: { inside: "allow", outside: "allow" },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(
      db.prepare("SELECT tool FROM tool_rules ORDER BY tool").all(),
    ).toEqual([{ tool: "bash" }]);
  });

  test("空对象：200 与全量", async () => {
    const r = await putRules({ rules: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().tools).toHaveLength(TOOLS.length + FRAMEWORK_TOOLS.length);
    expect(db.prepare("SELECT count(*) AS n FROM tool_rules").get()).toEqual({
      n: 0,
    });
  });

  test("任一项不合格就整批 400，一项都不写，message 点名那个工具", async () => {
    await putRule("bash", { inside: "allow", outside: "allow" });
    const cases: Array<[unknown, string]> = [
      [
        { rules: { read: { inside: "ask", outside: "ask" }, nope: {} } },
        "nope",
      ],
      [
        {
          rules: {
            read: { inside: "ask", outside: "ask" },
            transfer_files: { inside: "ask", outside: "ask" },
          },
        },
        "transfer_files",
      ],
      [
        {
          rules: {
            write: { inside: "ask", outside: "ask" },
            spawn_subagent: { inside: "ask", outside: "allow" },
          },
        },
        "spawn_subagent",
      ],
      [{ rules: { read: { inside: "ask", outside: "deny" } } }, "read"],
    ];
    for (const [body, name] of cases) {
      const r = await putRules(body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_rule");
      expect(r.json().message).toContain(name);
    }
    expect(db.prepare("SELECT tool FROM tool_rules").all()).toEqual([
      { tool: "bash" },
    ]);
    // body 本身不合法也 400
    for (const body of [{}, { rules: [] }, { rules: "x" }])
      expect((await putRules(body)).statusCode).toBe(400);
  });
});
