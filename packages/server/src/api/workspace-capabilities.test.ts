import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityStore } from "../store/capabilities.js";
import { type Db, openDatabase } from "../store/db.js";
import { McpStore } from "../store/mcp.js";
import { SkillStore } from "../store/skills.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { registerWorkspaceCapabilityRoutes } from "./workspace-capabilities.js";

const md = (name: string) =>
  Buffer.from(`---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n正文\n`);

let dir: string;
let db: Db;
let app: FastifyInstance;
let workspaces: WorkspaceStore;
let wsId: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-ws-caps-"));
  db = openDatabase(dir);
  workspaces = new WorkspaceStore(db);
  const capabilities = new CapabilityStore(db);
  const skills = new SkillStore(db, path.join(dir, "skills"));
  const mcp = new McpStore(db);
  wsId = workspaces.create({ name: "w" }).id;
  skills.create("a-skill", "project", "test", [
    { path: "SKILL.md", content: md("a-skill") },
  ]);
  mcp.create("m", {
    transport: "stdio",
    command: process.execPath,
    args: [],
    env: [],
  });
  app = Fastify();
  app.register(registerWorkspaceCapabilityRoutes, {
    workspaces,
    capabilities,
    skills,
    mcp,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: "GET", url });
const put = (url: string, payload: unknown) =>
  app.inject({ method: "PUT", url, payload: payload as object });
const url = (id = wsId) => `/api/v1/workspaces/${id}/capabilities`;

describe("工作区能力分配", () => {
  test("GET 空、PUT 整体替换、再 GET 往返", async () => {
    expect((await get(url())).json()).toEqual({ skill: [], mcp: [] });
    let r = await put(url(), { skill: ["a-skill"], mcp: ["m"] });
    expect(r.json()).toEqual({ skill: ["a-skill"], mcp: ["m"] });
    expect((await get(url())).json()).toEqual({
      skill: ["a-skill"],
      mcp: ["m"],
    });
    // 整体替换
    r = await put(url(), { skill: [], mcp: ["m"] });
    expect(r.json()).toEqual({ skill: [], mcp: ["m"] });
  });

  test("缺省的类别不动", async () => {
    await put(url(), { skill: ["a-skill"], mcp: ["m"] });
    const r = await put(url(), { mcp: [] });
    expect(r.json()).toEqual({ skill: ["a-skill"], mcp: [] });
    expect((await put(url(), {})).json()).toEqual({
      skill: ["a-skill"],
      mcp: [],
    });
  });

  test("未知名字 400 并点名，且不落库", async () => {
    let r = await put(url(), { skill: ["gone"] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "unknown_skill", message: "gone" });
    r = await put(url(), { mcp: ["gone"] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "unknown_mcp", message: "gone" });
    // 同一请求里合法的那类也不落库
    r = await put(url(), { skill: ["a-skill"], mcp: ["gone"] });
    expect(r.statusCode).toBe(400);
    expect((await get(url())).json()).toEqual({ skill: [], mcp: [] });
  });

  test("元素不是字符串 400", async () => {
    for (const body of [{ skill: "a-skill" }, { mcp: [1] }, { skill: [null] }])
      expect((await put(url(), body)).statusCode).toBe(400);
  });

  test("工作区不存在 404", async () => {
    expect((await get(url("nope"))).statusCode).toBe(404);
    expect((await put(url("nope"), { skill: [] })).statusCode).toBe(404);
  });
});
