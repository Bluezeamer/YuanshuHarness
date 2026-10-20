import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EnvHub } from "../env/hub.js";
import { SkillRuntime } from "../skills/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { SkillStore } from "../store/skills.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { skillsApi } from "./skills.js";

const md = (name: string, description = "测试用 skill") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

let dir: string;
let home: string;
let realHome: string | undefined;
let db: Db;
let app: FastifyInstance;
let workspaces: WorkspaceStore;
let skills: SkillStore;
let hub: EnvHub;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-skills-api-"));
  home = path.join(dir, "home");
  mkdirSync(home);
  // LocalEnv.homedir() 取 os.homedir()，测试里指到临时目录，避免扫到真实用户目录。
  realHome = process.env.HOME;
  process.env.HOME = home;
  db = openDatabase(dir);
  skills = new SkillStore(db, path.join(dir, "skills"));
  workspaces = new WorkspaceStore(db);
  const environments = new EnvironmentStore(db);
  const capabilities = new CapabilityStore(db);
  hub = new EnvHub(environments, new SecretStore(db, loadMasterKey(dir)));
  app = Fastify();
  app.register(skillsApi, {
    skills,
    capabilities,
    workspaces,
    environments,
    hub,
    runtime: new SkillRuntime({ skills, capabilities }),
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  hub.close();
  db.close();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });
const put = (url: string, payload: unknown) =>
  app.inject({ method: "PUT", url, payload: payload as object });
const create = (name: string, scope = "global") =>
  post("/api/v1/skills", { name, scope, content: md(name) });

describe("库 CRUD 与文件树", () => {
  test("新建、读取、改文件、删除", async () => {
    const r = await create("demo");
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "demo",
      description: "测试用 skill",
      source: "local",
    });
    expect((await create("demo")).statusCode).toBe(409);

    const w = await put("/api/v1/skills/demo/file", {
      path: "scripts/run.sh",
      content: "echo hi\n",
    });
    expect(w.statusCode).toBe(200);
    const detail = (await app.inject("/api/v1/skills/demo")).json();
    expect(detail.files.map((f: { path: string }) => f.path)).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    const got = await app.inject(
      "/api/v1/skills/demo/file?path=scripts/run.sh",
    );
    expect(got.json()).toEqual({
      path: "scripts/run.sh",
      content: "echo hi\n",
    });

    const d = await app.inject({
      method: "DELETE",
      url: "/api/v1/skills/demo/file?path=scripts/run.sh",
    });
    expect(d.statusCode).toBe(200);
    expect(
      (await app.inject("/api/v1/skills/demo/file?path=scripts/run.sh"))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/skills/demo/file?path=SKILL.md",
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/skills/demo" }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject("/api/v1/skills")).json().skills).toEqual([]);
  });

  test("frontmatter 不合规：创建与改写 SKILL.md 都被拒，库不变", async () => {
    const r = await post("/api/v1/skills", {
      name: "oops",
      scope: "global",
      content: "没有 frontmatter",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toContain("description");

    await create("ok-one");
    const w = await put("/api/v1/skills/ok-one/file", {
      path: "SKILL.md",
      content: "---\nname: other\ndescription: x\n---\n",
    });
    expect(w.statusCode).toBe(400);
    expect(w.json().message).toContain("一致");
    expect(
      (await app.inject("/api/v1/skills/ok-one")).json().skill.description,
    ).toBe("测试用 skill");
  });

  test("validate 返回错误与警告但不落盘", async () => {
    const v = await post("/api/v1/skills/validate", {
      name: "abc",
      content: "---\ndescription: d\n---\n",
    });
    expect(v.json()).toEqual({
      errors: [],
      warnings: ["frontmatter 缺少 name，将回退为目录名"],
    });
    expect((await app.inject("/api/v1/skills")).json().skills).toEqual([]);
  });

  test("路径穿越被拒", async () => {
    await create("safe");
    for (const p of ["../x", "a/../../x", "/etc/passwd", "a//b", "a\\b", "."]) {
      const w = await put("/api/v1/skills/safe/file", {
        path: p,
        content: "x",
      });
      expect(w.statusCode, p).toBe(400);
      const g = await app.inject({
        method: "GET",
        url: "/api/v1/skills/safe/file",
        query: { path: p },
      });
      expect(g.statusCode, p).toBe(400);
    }
  });

  test("改作用域", async () => {
    await create("scoped");
    const r = await app.inject({
      method: "PATCH",
      url: "/api/v1/skills/scoped",
      payload: { scope: "project" },
    });
    expect(r.json().scope).toBe("project");
  });
});

describe("识别环境里的 skill 并纳入库", () => {
  const seed = () => {
    const ws = path.join(dir, "proj");
    mkdirSync(path.join(home, ".agents/skills/shared/scripts"), {
      recursive: true,
    });
    writeFileSync(
      path.join(home, ".agents/skills/shared/SKILL.md"),
      md("shared"),
    );
    writeFileSync(
      path.join(home, ".agents/skills/shared/scripts/a.sh"),
      "echo a\n",
    );
    mkdirSync(path.join(ws, ".pi/skills/local-only"), { recursive: true });
    writeFileSync(
      path.join(ws, ".pi/skills/local-only/SKILL.md"),
      md("local-only"),
    );
    // 元枢命名空间里的是同步产物，只识别不可纳入。
    mkdirSync(path.join(home, ".agents/skills/yuanshu/synced"), {
      recursive: true,
    });
    writeFileSync(
      path.join(home, ".agents/skills/yuanshu/synced/SKILL.md"),
      md("synced"),
    );
    return workspaces.create("proj", ws);
  };

  test("扫描约定目录，区分来源与命名空间", async () => {
    const ws = seed();
    const r = await app.inject(
      `/api/v1/environments/local/skills?workspaceId=${ws?.id}`,
    );
    const found = r.json().skills as {
      name: string;
      root: string;
      managed: boolean;
      inLibrary: boolean;
    }[];
    const by = Object.fromEntries(found.map((s) => [s.name, s]));
    expect(by.shared).toMatchObject({ root: "user-agents", managed: false });
    expect(by["local-only"]).toMatchObject({
      root: "project-pi",
      managed: false,
    });
    expect(by.synced).toMatchObject({ managed: true });
    const noWs = (await app.inject("/api/v1/environments/local/skills")).json()
      .skills;
    expect(noWs.map((s: { name: string }) => s.name).sort()).toEqual([
      "shared",
      "synced",
    ]);
  });

  test("纳入库带上整个目录；重复、范围外目录、命名空间产物被拒", async () => {
    const ws = seed();
    const dirOf = (p: string) => path.join(home, ".agents/skills", p);
    const r = await post("/api/v1/skills/import", {
      environmentId: "local",
      dir: dirOf("shared"),
      scope: "global",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: "shared", source: "env:本机" });
    expect(
      skills
        .files("shared")
        .map((f) => f.path)
        .sort(),
    ).toEqual(["SKILL.md", "scripts/a.sh"]);

    const again = await post("/api/v1/skills/import", {
      environmentId: "local",
      dir: dirOf("shared"),
      scope: "global",
    });
    expect(again.statusCode).toBe(409);
    const outside = await post("/api/v1/skills/import", {
      environmentId: "local",
      dir: "/etc",
      scope: "global",
    });
    expect(outside.json().error).toBe("not_a_skill_dir");
    const managed = await post("/api/v1/skills/import", {
      environmentId: "local",
      dir: dirOf("yuanshu/synced"),
      scope: "global",
    });
    expect(managed.json().error).toBe("not_a_skill_dir");

    const proj = await post("/api/v1/skills/import", {
      environmentId: "local",
      workspaceId: ws?.id,
      dir: path.join(ws?.path ?? "", ".pi/skills/local-only"),
      scope: "project",
    });
    expect(proj.statusCode).toBe(201);
  });
});

describe("workspace 级分配", () => {
  test("只能分配项目级 skill；删除 skill 后分配随之清除", async () => {
    const ws = workspaces.create("w", dir);
    const url = `/api/v1/workspaces/${ws?.id}/skills`;
    await create("proj-skill", "project");
    await create("glob-skill", "global");

    expect((await put(url, { names: ["glob-skill"] })).json().error).toBe(
      "not_project_scope",
    );
    expect((await put(url, { names: ["nope"] })).json().error).toBe(
      "unknown_skill",
    );
    expect((await put(url, { names: ["proj-skill"] })).json()).toEqual({
      names: ["proj-skill"],
    });
    expect((await app.inject(url)).json()).toEqual({ names: ["proj-skill"] });

    await app.inject({ method: "DELETE", url: "/api/v1/skills/proj-skill" });
    expect((await app.inject(url)).json()).toEqual({ names: [] });
    expect(
      (await app.inject("/api/v1/workspaces/nope/skills")).statusCode,
    ).toBe(404);
  });
});
