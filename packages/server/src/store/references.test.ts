import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { variablesApi } from "../api/variables.js";
import type { MaskVar } from "../permission/masking.js";
import { AuditLog } from "./audit.js";
import { DB_FILE, type Db, MIGRATIONS, openDatabase } from "./db.js";
import {
  REF_COMMAND_MAX,
  type ReferenceInput,
  ReferenceStore,
  refCommand,
} from "./references.js";
import { loadMasterKey, SecretStore } from "./secrets.js";
import { WorkspaceVariableStore } from "./workspace-variables.js";
import { WorkspaceStore } from "./workspaces.js";

// 引用记录的「命令」列：只存占位符原文，已遮罩、已截断；真值绝不落库。
const LONG = "glpat-AbCdEf0123456789xyz"; // 25 字符，超过输出遮罩下限
const SHORT = "pw42"; // 登记下限（4）刚好，短于输出遮罩下限 8
const VARS: MaskVar[] = [
  { name: "other.token", value: LONG },
  { name: "sudo.pw", value: SHORT },
  {
    name: "ssh-key",
    value: "-----KEY-----\nabcdef\n",
    label: "[凭据 ssh-key]",
  },
];

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-refs-"));
  db = openDatabase(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<ReferenceInput> = {}): ReferenceInput => ({
  name: "api.token",
  directoryId: "ws1",
  hostId: "server",
  runId: "r1",
  toolCallId: "tc1",
  result: "ok",
  ...over,
});
const stored = (store: ReferenceStore) => store.list().entries;

describe("refCommand", () => {
  test("短命令原样保留占位符，不改写成值", () => {
    const cmd = "curl -H 'Authorization: {{@api.token}}' https://x.example";
    expect(refCommand(cmd, "api.token", VARS)).toBe(cmd);
  });

  test("命令里出现别的变量的真值：遮成占位符，登记下限以上的短值也遮", () => {
    const out = refCommand(
      `echo ${LONG} ${SHORT} {{@api.token}} -----KEY-----\nabcdef\n`,
      "api.token",
      VARS,
    );
    expect(out).toBe(
      "echo {{@other.token}} {{@sudo.pw}} {{@api.token}} [凭据 ssh-key]",
    );
    for (const v of VARS) expect(out).not.toContain(v.value);
  });

  test(`超长截断到 ${REF_COMMAND_MAX} 字符，窗口里保留该变量的占位符，两端被切处补 …`, () => {
    const cmd = `${"a".repeat(800)} {{@api.token}} ${"b".repeat(800)}`;
    const out = refCommand(cmd, "api.token", VARS);
    expect(out).toHaveLength(REF_COMMAND_MAX);
    expect(out).toContain("{{@api.token}}");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  test("占位符在末尾：只在前端补 …；占位符在开头：只在尾端补 …", () => {
    const tail = refCommand(
      `${"a".repeat(900)} {{@api.token}}`,
      "api.token",
      VARS,
    );
    expect(tail).toHaveLength(REF_COMMAND_MAX);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("{{@api.token}}")).toBe(true);
    const head = refCommand(
      `{{@api.token}} ${"a".repeat(900)}`,
      "api.token",
      VARS,
    );
    expect(head).toHaveLength(REF_COMMAND_MAX);
    expect(head.startsWith("{{@api.token}}")).toBe(true);
    expect(head.endsWith("…")).toBe(true);
  });

  test("先遮罩再截断：真值恰好被窗口边界切开，也不会漏出残片", () => {
    // 窗口起点落在 LONG 中间；若先截断，只剩 LONG 的后半截，遮罩匹配不到
    const cmd = `${"a".repeat(10)}${LONG}${"b".repeat(470)} {{@api.token}}`;
    const out = refCommand(cmd, "api.token", VARS);
    expect(out.length).toBeLessThanOrEqual(REF_COMMAND_MAX);
    expect(out).toContain("{{@api.token}}");
    // 任何长于 5 的真值片段都不许出现（前缀与后缀两头都查）
    for (let n = 6; n <= LONG.length; n++) {
      expect(out).not.toContain(LONG.slice(0, n));
      expect(out).not.toContain(LONG.slice(-n));
    }
  });

  test("旧的裸 @名称 写法（旧文法名）也能定位", () => {
    const out = refCommand(
      `${"a".repeat(900)} curl -u @svc_tok`,
      "svc_tok",
      [],
    );
    expect(out).toHaveLength(REF_COMMAND_MAX);
    expect(out.endsWith("@svc_tok")).toBe(true);
  });
});

describe("ReferenceStore.record / list", () => {
  test("存命令：真值不落库，占位符保留；list 返回 command", () => {
    const store = new ReferenceStore(db, () => VARS);
    store.record(
      input({
        command: `curl -u user:${LONG} -H '{{@api.token}}' --pw ${SHORT}`,
      }),
    );
    const [rec] = stored(store);
    expect(rec?.command).toBe(
      "curl -u user:{{@other.token}} -H '{{@api.token}}' --pw {{@sudo.pw}}",
    );
    // 整行原始数据里也没有真值
    const raw = JSON.stringify(db.prepare("SELECT * FROM variable_refs").all());
    for (const v of VARS)
      expect(raw).not.toContain(JSON.stringify(v.value).slice(1, -1));
  });

  test("没给遮罩源：不存命令（宁可留空，不冒落库明文的险），记录本身照写", () => {
    const store = new ReferenceStore(db);
    store.record(input({ command: `echo ${LONG} {{@api.token}}` }));
    expect(stored(store)).toHaveLength(1);
    expect(stored(store)[0]?.command).toBeNull();
    expect(
      JSON.stringify(db.prepare("SELECT * FROM variable_refs").all()),
    ).not.toContain(LONG);
  });

  test("遮罩源出错：不存命令，记录本身照写", () => {
    const store = new ReferenceStore(db, () => {
      throw new Error("boom");
    });
    store.record(input({ command: `echo ${LONG}` }));
    expect(stored(store)).toHaveLength(1);
    expect(stored(store)[0]?.command).toBeNull();
  });

  test("没带命令（或空串）：command 为 null", () => {
    const store = new ReferenceStore(db, () => VARS);
    store.record(input());
    store.record(input({ command: "", toolCallId: "tc2" }));
    expect(stored(store).map((r) => r.command)).toEqual([null, null]);
  });
});

describe("GET /api/v1/references", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    const store = new ReferenceStore(db, () => VARS);
    store.record(
      input({ command: `echo ${LONG} {{@api.token}}`, toolCallId: "tc-new" }),
    );
    store.record(input({ toolCallId: "tc-none" }));
    app = Fastify();
    app.register(variablesApi, {
      secrets: new SecretStore(db, loadMasterKey(dir)),
      audit: new AuditLog(db),
      references: store,
      workspaces: new WorkspaceStore(db),
      workspaceVariables: new WorkspaceVariableStore(db),
    });
    await app.ready();
  });
  afterEach(() => app.close());

  test("有命令的记录带 command（已遮罩）；没有命令的记录不带该字段", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/references" });
    const { references } = res.json() as {
      references: Array<Record<string, unknown>>;
    };
    expect(references[0]).not.toHaveProperty("command");
    expect(references[1]?.command).toBe("echo {{@other.token}} {{@api.token}}");
    expect(res.body).not.toContain(LONG);
  });
});
