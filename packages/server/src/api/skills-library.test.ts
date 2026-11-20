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
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { EnvHub } from "../env/hub.js";
import { LocalEnv } from "../env/local.js";
import {
  compareVersions,
  FetchError,
  type FoundSkill,
  type SkillFetcher,
} from "../skills/fetch.js";
import { SkillLibrary } from "../skills/library.js";
import { resolveSkills } from "../skills/resolve.js";
import { SkillRuntime } from "../skills/runtime.js";
import type { TrackedSource } from "../skills/source.js";
import { CapabilityStore } from "../store/capabilities.js";
import { type Db, openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import type { Environment, EnvironmentStore } from "../store/environments.js";
import { SkillStore } from "../store/skills.js";
import { WorkspaceDirectoryStore } from "../store/workspace-directories.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { skillsApi } from "./skills.js";

const md = (name: string, body = "正文", description = `测试 ${name}`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

// 每台「环境」是一个本机实现，只是 home 指到不同的临时目录。
class HomeEnv extends LocalEnv {
  constructor(private readonly home: string) {
    super();
  }
  override homedir = async () => this.home;
}

// 假的来源：npm 按 key `npm:pkg`、git 按 key `git:host/org/repo` 存内容；git 提交号从 1 递增。
interface Repo {
  tip: string;
  branch: string;
  tags: Map<string, string>;
  // 提交号 → (技能目录 → 技能名)；根目录用 "."。
  commits: Map<string, Map<string, string>>;
}

class FakeFetcher implements SkillFetcher {
  readonly pkgs = new Map<string, Map<string, string>>();
  readonly repos = new Map<string, Repo>();
  fetchCalls: string[] = [];
  versionCalls = 0;
  offline = false;
  private seq = 0;

  private key(s: TrackedSource) {
    return s.kind === "npm" ? `npm:${s.pkg}` : `git:${s.url}`;
  }
  publish(key: string, version: string, name: string) {
    const m = this.pkgs.get(key) ?? new Map<string, string>();
    m.set(version, name);
    this.pkgs.set(key, m);
  }
  // 推一个新提交（可以一次放多个技能目录），返回提交号。
  commit(url: string, skills: Record<string, string>, branch = "main") {
    const key = `git:${url}`;
    const repo = this.repos.get(key) ?? {
      tip: "",
      branch,
      tags: new Map<string, string>(),
      commits: new Map<string, Map<string, string>>(),
    };
    this.seq++;
    const sha = this.seq.toString(16).padStart(40, "0");
    repo.tip = sha;
    repo.commits.set(sha, new Map(Object.entries(skills)));
    this.repos.set(key, repo);
    return sha;
  }
  tag(url: string, tag: string) {
    this.repos.get(`git:${url}`)?.tags.set(tag, this.tipOf(url));
  }
  tipOf(url: string) {
    return this.repos.get(`git:${url}`)?.tip ?? "";
  }

  async versions(source: TrackedSource): Promise<string[]> {
    this.versionCalls++;
    if (this.offline) throw new FetchError("network", "无法连接来源");
    if (source.kind === "npm") {
      const m = this.pkgs.get(this.key(source));
      if (!m) throw new FetchError("not_found", "来源不存在");
      return [...m.keys()].sort((a, b) => compareVersions(b, a));
    }
    const repo = this.repos.get(this.key(source));
    if (!repo) throw new FetchError("not_found", "来源不存在");
    const ref = source.ref;
    if (ref === undefined || ref === repo.branch) return [repo.tip];
    if (/^[0-9a-f]{40}$/.test(ref)) return [ref];
    // 其余当 tag 列表：新到旧。
    return [...repo.tags.keys()]
      .sort((a, b) => compareVersions(b, a))
      .map((tag) => tag);
  }

  async fetch(
    source: TrackedSource,
    version: string,
    hint: string,
  ): Promise<FoundSkill> {
    this.fetchCalls.push(`${this.key(source)}@${version}`);
    if (this.offline) throw new FetchError("network", "无法连接来源");
    if (source.kind === "npm") {
      const name = this.pkgs.get(this.key(source))?.get(version);
      if (!name) throw new FetchError("not_found", "版本不存在");
      return { name, files: skillFiles(name, version) };
    }
    const repo = this.repos.get(this.key(source));
    if (!repo) throw new FetchError("not_found", "来源不存在");
    const commit =
      version === "HEAD" || version === repo.branch
        ? repo.tip
        : (repo.tags.get(version) ??
          (/^[0-9a-f]{40}$/.test(version) ? version : ""));
    const skills = repo.commits.get(commit);
    if (!commit || !skills) throw new FetchError("not_found", "版本不存在");
    // 版本是 tag 名还是在某个分支 / 提交上，决定库里存 tag 还是提交号。
    const tag = repo.tags.has(version);
    if (source.subdir) {
      const name = skills.get(source.subdir);
      if (!name) throw new FetchError("no_skill", "该目录里没有技能");
      return { name, files: skillFiles(name, commit), commit, tag };
    }
    if (skills.size === 1) {
      const [only] = [...skills.values()];
      return {
        name: only as string,
        files: skillFiles(only as string, commit),
        commit,
        tag,
      };
    }
    const hit = [...skills.entries()].filter(([, n]) => n === hint);
    if (hit.length === 1) {
      const name = hit[0]?.[1] as string;
      return { name, files: skillFiles(name, commit), commit, tag };
    }
    throw new FetchError(
      "ambiguous",
      `来源里有多个技能，无法确定装哪一个`,
      [...skills.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([dir, name]) => ({
          name,
          path: dir === "." ? "" : dir,
          description: `测试 ${name}`,
        })),
    );
  }
}

const skillFiles = (name: string, version: string): FoundSkill["files"] => [
  { path: "SKILL.md", content: Buffer.from(md(name, `内容 ${version}`)) },
  { path: "references/v.md", content: Buffer.from(`版本 ${version}`) },
];

let dir: string;
let db: Db;
let app: FastifyInstance;
let skills: SkillStore;
let directories: DirectoryStore;
let workspaceDirectories: WorkspaceDirectoryStore;
let capabilities: CapabilityStore;
let library: SkillLibrary;
let fetcher: FakeFetcher;
let homes: Record<string, string>;
let hostIds: string[];

const copyDir = (host: string, name: string) =>
  path.join(homes[host] as string, ".agents/skills/yuanshu", name);
const copyMd = (host: string, name: string) =>
  readFileSync(path.join(copyDir(host, name), "SKILL.md"), "utf8");

// hostsOverride：缺省三台环境 a / b / c（a 即 local）。
const setup = async (
  opts: { hosts?: string[]; probeTimeoutMs?: number } = {},
) => {
  hostIds = opts.hosts ?? ["local", "h-b", "h-c"];
  homes = {};
  const envs = new Map<string, HomeEnv>();
  for (const id of hostIds) {
    homes[id] = path.join(dir, `home-${id}`);
    mkdirSync(homes[id] as string, { recursive: true });
    envs.set(id, new HomeEnv(homes[id] as string));
  }
  const hub = {
    get: (id: string) => envs.get(id) ?? null,
  } as unknown as EnvHub;
  const environments = {
    list: () => hostIds.map((id) => ({ id, name: id }) as Environment),
    get: (id: string) =>
      hostIds.includes(id) ? ({ id, name: id } as Environment) : null,
  } as unknown as EnvironmentStore;
  fetcher = new FakeFetcher();
  library = new SkillLibrary({
    skills,
    capabilities,
    directories,
    workspaceDirectories,
    environments,
    hub,
    fetcher,
    ...(opts.probeTimeoutMs ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
  });
  app = Fastify();
  app.register(skillsApi, {
    skills,
    directories,
    environments,
    hub,
    runtime: new SkillRuntime({
      skills,
      capabilities,
      load: (m) => library.loadInput(m),
    }),
    library,
  });
  await app.ready();
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-skills-lib-"));
  db = openDatabase(dir);
  skills = new SkillStore(db, path.join(dir, "skills"));
  directories = new DirectoryStore(db);
  workspaceDirectories = new WorkspaceDirectoryStore(db);
  capabilities = new CapabilityStore(db);
  await setup();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, payload: (payload ?? {}) as object });
const get = async (url: string) => (await app.inject(url)).json();
const install = (kind: string, spec: string) =>
  post("/api/v1/skills/install", { source: { kind, spec } });
const publishAll = (v: string) =>
  fetcher.publish("npm:@acme/pi-skills", v, "code-review");
type Dist = {
  hostId: string;
  state: string;
  version: string | null;
  error?: string;
};
const distOf = async (name: string) =>
  ((await get(`/api/v1/skills/${name}`)).skill.dist as Dist[]).map(
    (d) => `${d.hostId}:${d.state}`,
  );

// 装好 code-review：库 1.4.2，来源还有 1.4.0 / 1.5.0。
// 新装默认是项目级；分发与按环境同步只对全局项成立，所以装完标成全局。
const seedNpm = async () => {
  for (const v of ["1.4.0", "1.4.2", "1.5.0"])
    fetcher.publish("npm:@acme/pi-skills", v, "code-review");
  const r = await install("npm", "@acme/pi-skills@1.4.2");
  skills.setScope("code-review", "global");
  return r;
};

describe("安装：来源校验与名称", () => {
  test("来源格式不合规一律 400 invalid_source，且不访问来源", async () => {
    for (const [kind, spec] of [
      ["npm", "pkg@latest"],
      ["npm", "pkg@^1.0.0"],
      ["npm", "Code-Review"],
      ["git", "https://github.com/od/skills@v1"],
      ["git", "git@github.com:od/skills@v1"],
      ["git", "github.com/od"],
      ["git", "github.com/od/skills@--upload-pack=sh"],
      ["dir", "skills/x"],
      ["auto", ""],
      ["auto", "code-review@latest"],
      ["zip", "x"],
    ] as const) {
      const r = await install(kind, spec);
      expect(r.statusCode, `${kind} ${spec}`).toBe(400);
      expect(r.json().error).toBe("invalid_source");
    }
    // 坏 subdir 也是来源错误
    const badSubdir = await post("/api/v1/skills/install", {
      source: { kind: "git", spec: "github.com/o/r", subdir: "../etc" },
    });
    expect(badSubdir.json().error).toBe("invalid_source");
    expect(
      (await post("/api/v1/skills/install", { source: "npm:x@1" })).statusCode,
    ).toBe(400);
    expect(fetcher.fetchCalls).toEqual([]);
  });

  test("名称取自 SKILL.md 且须满足文法；不合法与重名都被拒", async () => {
    fetcher.publish("npm:lead-dash-", "1.0.0", "-ab");
    fetcher.publish("npm:upper", "1.0.0", "ABC");
    fetcher.publish("npm:double", "1.0.0", "a--b");
    for (const pkg of ["lead-dash-", "upper", "double"]) {
      const r = await install("npm", `${pkg}@1.0.0`);
      expect(r.statusCode, pkg).toBe(400);
      expect(r.json().error).toBe("invalid_name");
    }
    // 长度不再是 3–32：单字符与数字开头都合法
    fetcher.publish("npm:one", "1.0.0", "a");
    fetcher.publish("npm:digit", "1.0.0", "1abc");
    expect((await install("npm", "one@1.0.0")).statusCode).toBe(201);
    expect((await install("npm", "digit@1.0.0")).statusCode).toBe(201);
    expect((await seedNpm()).statusCode).toBe(201);
    const dup = await install("npm", "@acme/pi-skills@1.5.0");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("name_exists");
    // 库里没有留下半成品（3 个）
    expect((await get("/api/v1/skills")).skills).toHaveLength(3);
  });

  test("来源不存在 / 无网络给明确错误，不挂起", async () => {
    const missing = await install("npm", "ghost@1.0.0");
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("source_not_found");
    fetcher.offline = true;
    const off = await install("npm", "ghost@1.0.0");
    expect(off.statusCode).toBe(502);
    expect(off.json().error).toBe("source_unreachable");
  });
});

describe("安装 npm / git：停在待分发", () => {
  test("装完版本、来源、哈希齐全；各环境都没有副本，也没有自动分发", async () => {
    const r = await seedNpm();
    expect(r.statusCode).toBe(201);
    const s = r.json();
    expect(s).toMatchObject({
      name: "code-review",
      description: "测试 code-review",
      version: "1.4.2",
      lockedVersion: null,
      enabled: true,
      status: "ready",
      origin: { kind: "npm", pkg: "@acme/pi-skills" },
      source: "npm:@acme/pi-skills",
      scope: "project",
    });
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    // 项目级不按环境分发，没有各环境的状态；seedNpm 随后标成全局，才有三台环境的「没有副本」
    expect(s.dist).toEqual([]);
    expect(await distOf("code-review")).toEqual([
      "local:missing",
      "h-b:missing",
      "h-c:missing",
    ]);
    for (const h of hostIds)
      expect(existsSync(copyDir(h, "code-review"))).toBe(false);
    expect(fetcher.fetchCalls).toEqual(["npm:@acme/pi-skills@1.4.2"]);
    // 库里存的是来源的内容
    expect(
      skills
        .files("code-review")
        .map((f) => f.path)
        .sort(),
    ).toEqual(["SKILL.md", "references/v.md"]);
  });

  test("npm：不写版本时取 latest（候选第一个），版本存包版本", async () => {
    for (const v of ["1.4.0", "1.5.0", "2.0.0"]) publishAll(v);
    const r = await install("auto", "@acme/pi-skills");
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "code-review",
      version: "2.0.0",
      origin: { kind: "npm", pkg: "@acme/pi-skills" },
      source: "npm:@acme/pi-skills",
    });
    expect(fetcher.fetchCalls).toEqual(["npm:@acme/pi-skills@2.0.0"]);
    // 包不存在 / 没有版本都是 source_not_found，库里不留东西
    const missing = await install("auto", "ghost-pkg");
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("source_not_found");
  });

  test("git：host/org/repo@tag，版本即 tag，origin 带 ref", async () => {
    const url = "github.com/od/design-skills";
    fetcher.commit(url, { "skills/web-prototype": "web-prototype" });
    fetcher.tag(url, "v2.3.0");
    const r = await install("git", `${url}@v2.3.0`);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "web-prototype",
      version: "v2.3.0",
      origin: {
        kind: "git",
        url,
        ref: "v2.3.0",
      },
    });
  });

  test("git：不写 ref 存提交号；远端前进后可更新；更新后变成新提交号", async () => {
    const url = "github.com/od/design-skills";
    const first = fetcher.commit(url, { ".": "web-prototype" }, "main");
    const r = await install("auto", `https://${url}`);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "web-prototype",
      version: first,
      latestVersion: null,
      origin: { kind: "git", url },
      status: "ready",
    });
    expect(fetcher.fetchCalls).toEqual([`git:${url}@HEAD`]);

    const second = fetcher.commit(url, { ".": "web-prototype" });
    expect((await get(`/api/v1/skills/web-prototype/versions`)).latest).toBe(
      second,
    );
    expect((await get("/api/v1/skills")).skills[0]).toMatchObject({
      version: first,
      latestVersion: second,
      status: "update-available",
    });
    const up = await post("/api/v1/skills/web-prototype/update");
    expect(up.json()).toMatchObject({
      changed: true,
      skill: { version: second, status: "ready" },
    });
  });

  test("git：脏仓库不写版本时，多技能报 ambiguous_skills 并带候选，带 subdir 重试成功", async () => {
    const url = "github.com/upstash/context7";
    fetcher.commit(url, {
      "packages/pi/skills/context7-docs": "context7-docs",
      "plugins/a/skills/context7-mcp": "context7-mcp",
    });
    const r = await install("auto", `https://${url}`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: "ambiguous_skills",
      candidates: [
        {
          name: "context7-docs",
          path: "packages/pi/skills/context7-docs",
          description: "测试 context7-docs",
        },
        {
          name: "context7-mcp",
          path: "plugins/a/skills/context7-mcp",
          description: "测试 context7-mcp",
        },
      ],
    });
    expect((await get("/api/v1/skills")).skills).toEqual([]);

    const again = await post("/api/v1/skills/install", {
      source: {
        kind: "auto",
        spec: `https://${url}`,
        subdir: "packages/pi/skills/context7-docs",
      },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({
      name: "context7-docs",
      origin: {
        kind: "git",
        url,
        subdir: "packages/pi/skills/context7-docs",
      },
      source: `git:${url}#packages/pi/skills/context7-docs`,
    });
  });

  test("git：锁定到旧提交号，更新被拒；库版本不越过锁定版", async () => {
    const url = "github.com/od/design-skills";
    const first = fetcher.commit(url, { ".": "web-prototype" });
    await install("auto", `https://${url}`);
    const second = fetcher.commit(url, { ".": "web-prototype" });
    // 先查一次候选，列表才靠它判断可更新（列表接口不联网）。
    expect((await get("/api/v1/skills/web-prototype/versions")).latest).toBe(
      second,
    );
    expect((await get("/api/v1/skills")).skills[0].status).toBe(
      "update-available",
    );
    const locked = await post("/api/v1/skills/web-prototype/lock", {
      version: first,
    });
    expect(locked.json()).toMatchObject({
      version: first,
      lockedVersion: first,
      status: "ready",
    });
    expect(skills.readFile("web-prototype", "SKILL.md")?.toString()).toContain(
      `内容 ${first}`,
    );
    const up = await post("/api/v1/skills/web-prototype/update");
    expect(up.statusCode).toBe(409);
    expect(up.json().error).toBe("locked");
    expect(skills.get("web-prototype")?.version).toBe(first);
    expect(second).not.toBe(first);
  });

  test("库里的来源镜像不可手改文件", async () => {
    await seedNpm();
    const w = await app.inject({
      method: "PUT",
      url: "/api/v1/skills/code-review/file",
      payload: { path: "x.md", content: "x" },
    });
    expect(w.statusCode).toBe(409);
    expect(w.json().error).toBe("read_only_source");
  });
});

describe("安装 dir 与 observed", () => {
  test("dir：复制进库，不跟踪版本；锁定被拒、版本列表为空", async () => {
    const src = path.join(dir, "pdf-tools");
    mkdirSync(path.join(src, "scripts"), { recursive: true });
    writeFileSync(path.join(src, "SKILL.md"), md("pdf-tools"));
    writeFileSync(path.join(src, "scripts/extract.py"), "print(1)\n");
    const r = await install("dir", src);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "pdf-tools",
      version: null,
      origin: { kind: "dir", path: src },
    });
    expect(skills.files("pdf-tools")).toHaveLength(2);
    const lock = await post("/api/v1/skills/pdf-tools/lock", {
      version: "1.0.0",
    });
    expect(lock.json().error).toBe("version_not_tracked");
    expect(await get("/api/v1/skills/pdf-tools/versions")).toMatchObject({
      tracked: false,
      versions: [],
    });
    // 来源目录改了，update 重新读取
    writeFileSync(path.join(src, "SKILL.md"), md("pdf-tools", "改过"));
    const up = await post("/api/v1/skills/pdf-tools/update");
    expect(up.json().changed).toBe(true);
    expect(skills.readFile("pdf-tools", "SKILL.md")?.toString()).toContain(
      "改过",
    );
    expect((await install("dir", path.join(dir, "nope"))).json().error).toBe(
      "source_not_found",
    );
  });

  const seedObserved = () => {
    const orig = path.join(
      homes["h-b"] as string,
      ".agents/skills/shared-tool",
    );
    mkdirSync(path.join(orig, "scripts"), { recursive: true });
    writeFileSync(path.join(orig, "SKILL.md"), md("shared-tool", "原件"));
    writeFileSync(path.join(orig, "scripts/a.sh"), "echo a\n");
    return orig;
  };
  // 纳入后同样标成全局：分发与按环境同步只对全局项成立。
  const observe = async (p: string, hostId = "h-b") => {
    const r = await post("/api/v1/skills/install", {
      source: { kind: "observed", hostId, path: p },
    });
    const name = r.json().name;
    if (typeof name === "string") skills.setScope(name, "global");
    return r;
  };

  test("observed：原地登记、库里不落任何文件；原件所在环境即一致", async () => {
    const orig = seedObserved();
    const r = await observe(orig);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "shared-tool",
      version: null,
      origin: { kind: "observed", hostId: "h-b", path: orig },
    });
    expect(existsSync(path.join(dir, "skills", "shared-tool"))).toBe(false);
    expect(await distOf("shared-tool")).toEqual([
      "local:missing",
      "h-b:in-sync",
      "h-c:missing",
    ]);
    // 详情的文件树与预览直接读环境里的原件
    const detail = await get("/api/v1/skills/shared-tool");
    expect(detail.files.map((f: { path: string }) => f.path)).toEqual([
      "SKILL.md",
      "scripts/a.sh",
    ]);
    const file = await get("/api/v1/skills/shared-tool/file?path=scripts/a.sh");
    expect(file.content).toBe("echo a\n");
    // 不可在库里改原件
    const w = await app.inject({
      method: "PUT",
      url: "/api/v1/skills/shared-tool/file",
      payload: { path: "scripts/a.sh", content: "x" },
    });
    expect(w.statusCode).toBe(409);
  });

  test("observed：只能登记环境里发现的技能目录，不能是任意目录或同步产物", async () => {
    const orig = seedObserved();
    mkdirSync(path.join(homes["h-b"] as string, "plain"), { recursive: true });
    writeFileSync(
      path.join(homes["h-b"] as string, "plain/SKILL.md"),
      md("plain"),
    );
    expect(
      (await observe(path.join(homes["h-b"] as string, "plain"))).json().error,
    ).toBe("not_a_skill_dir");
    expect((await observe("/etc")).json().error).toBe("not_a_skill_dir");
    expect((await observe(orig, "nope")).statusCode).toBe(404);
    // 同步产物（元枢命名空间）不可登记
    mkdirSync(copyDir("h-b", "synced-one"), { recursive: true });
    writeFileSync(
      path.join(copyDir("h-b", "synced-one"), "SKILL.md"),
      md("synced-one"),
    );
    expect((await observe(copyDir("h-b", "synced-one"))).json().error).toBe(
      "not_a_skill_dir",
    );
  });

  test("observed 分发到别的环境；卸载清理分发的副本，原件保留", async () => {
    const orig = seedObserved();
    await observe(orig);
    const d = await post("/api/v1/skills/shared-tool/distribute", {
      hostIds: ["local", "h-b"],
    });
    expect(d.statusCode).toBe(200);
    expect(d.json().results).toEqual([
      { hostId: "local", status: "added" },
      { hostId: "h-b", status: "unchanged", message: "原件所在环境，无需分发" },
    ]);
    expect(copyMd("local", "shared-tool")).toContain("原件");
    expect(existsSync(copyDir("h-b", "shared-tool"))).toBe(false);

    const b = await post("/api/v1/skills/batch", {
      names: ["shared-tool"],
      action: "uninstall",
    });
    expect(b.json().results).toEqual([
      {
        name: "shared-tool",
        ok: true,
        cleaned: ["local"],
        failed: [],
        keptInPlace: orig,
      },
    ]);
    expect(existsSync(copyDir("local", "shared-tool"))).toBe(false);
    expect(readFileSync(path.join(orig, "SKILL.md"), "utf8")).toContain("原件");
    expect((await get("/api/v1/skills")).skills).toEqual([]);
  });

  test("observed 原件改动后，分发推的是当前内容，库里的哈希随之刷新", async () => {
    const orig = seedObserved();
    const before = (await observe(orig)).json().hash;
    writeFileSync(path.join(orig, "SKILL.md"), md("shared-tool", "改后"));
    await post("/api/v1/skills/shared-tool/distribute", { hostIds: ["local"] });
    expect(copyMd("local", "shared-tool")).toContain("改后");
    expect(skills.get("shared-tool")?.hash).not.toBe(before);
    expect(await distOf("shared-tool")).toContain("local:in-sync");
  });
});

describe("版本：候选、更新、锁定、补齐（D11）", () => {
  test("候选列表标当前与最新；更新后列表里出现可更新", async () => {
    await seedNpm();
    const v = await get("/api/v1/skills/code-review/versions");
    expect(v).toMatchObject({
      tracked: true,
      current: "1.4.2",
      latest: "1.5.0",
    });
    expect(v.versions).toEqual([
      { version: "1.5.0", current: false, latest: true },
      { version: "1.4.2", current: true, latest: false },
      { version: "1.4.0", current: false, latest: false },
    ]);
    const list = (await get("/api/v1/skills")).skills;
    expect(list[0]).toMatchObject({
      latestVersion: "1.5.0",
      status: "update-available",
    });
  });

  test("无网络：versions / update 立即返回明确错误，库不变", async () => {
    await seedNpm();
    fetcher.offline = true;
    for (const url of ["/api/v1/skills/code-review/versions"]) {
      const r = await app.inject(url);
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toBe("source_unreachable");
    }
    const up = await post("/api/v1/skills/code-review/update");
    expect(up.statusCode).toBe(502);
    expect(skills.get("code-review")?.version).toBe("1.4.2");
  });

  test("update 只改库版本，不分发；环境副本变成落后；已是最新则 changed=false", async () => {
    await seedNpm();
    await post("/api/v1/skills/code-review/distribute", {
      hostIds: ["local", "h-b"],
    });
    expect(copyMd("local", "code-review")).toContain("内容 1.4.2");

    const up = await post("/api/v1/skills/code-review/update");
    expect(up.json()).toMatchObject({
      changed: true,
      skill: { version: "1.5.0", latestVersion: "1.5.0", status: "ready" },
    });
    expect(copyMd("local", "code-review")).toContain("内容 1.4.2");
    expect(await distOf("code-review")).toEqual([
      "local:behind",
      "h-b:behind",
      "h-c:missing",
    ]);
    const again = await post("/api/v1/skills/code-review/update");
    expect(again.json().changed).toBe(false);
  });

  test("lock：库换成锁定版并标记；锁定期间不催更新、update 被拒", async () => {
    await seedNpm();
    const r = await post("/api/v1/skills/code-review/lock", {
      version: "1.4.0",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      version: "1.4.0",
      lockedVersion: "1.4.0",
      status: "ready",
    });
    expect(skills.readFile("code-review", "SKILL.md")?.toString()).toContain(
      "内容 1.4.0",
    );
    // 此时库里已知最新版 1.5.0，但锁定期间状态仍是 ready
    await get("/api/v1/skills/code-review/versions");
    expect((await get("/api/v1/skills")).skills[0].status).toBe("ready");
    const up = await post("/api/v1/skills/code-review/update");
    expect(up.statusCode).toBe(409);
    expect(up.json().error).toBe("locked");
    // 版本格式与不存在的版本
    expect(
      (
        await post("/api/v1/skills/code-review/lock", { version: "latest" })
      ).json().error,
    ).toBe("invalid_version");
    expect(
      (await post("/api/v1/skills/code-review/lock", {})).json().error,
    ).toBe("invalid_version");
    expect(
      (
        await post("/api/v1/skills/code-review/lock", { version: "9.9.9" })
      ).json().error,
    ).toBe("source_not_found");
    expect(skills.get("code-review")?.lockedVersion).toBe("1.4.0");
  });

  test("D11：锁定后 sync 补齐只补到锁定版，不联网、不跟最新", async () => {
    await seedNpm();
    await post("/api/v1/skills/code-review/distribute", {
      hostIds: ["local", "h-b"],
    });
    await post("/api/v1/skills/code-review/lock", { version: "1.4.0" });
    await get("/api/v1/skills/code-review/versions"); // 库已知最新是 1.5.0
    const calls = fetcher.fetchCalls.length;
    const versionCalls = fetcher.versionCalls;

    const s = await post("/api/v1/skills/code-review/sync");
    expect(s.statusCode).toBe(200);
    // 只拉回落后的两台，没有副本的 h-c 不动
    expect(s.json().results).toEqual([
      { hostId: "local", status: "updated" },
      { hostId: "h-b", status: "updated" },
    ]);
    expect(copyMd("local", "code-review")).toContain("内容 1.4.0");
    expect(copyMd("h-b", "code-review")).toContain("内容 1.4.0");
    expect(existsSync(copyDir("h-c", "code-review"))).toBe(false);
    expect(await distOf("code-review")).toEqual([
      "local:in-sync",
      "h-b:in-sync",
      "h-c:missing",
    ]);
    // sync 没有产生任何来源访问；库版本仍是锁定版
    expect(fetcher.fetchCalls.length).toBe(calls);
    expect(fetcher.versionCalls).toBe(versionCalls);
    expect(skills.get("code-review")?.version).toBe("1.4.0");

    // 指定环境时可以补到没有副本的环境，同样是锁定版
    const d = await post("/api/v1/skills/code-review/sync", {
      hostIds: ["h-c"],
    });
    expect(d.json().results).toEqual([{ hostId: "h-c", status: "added" }]);
    expect(copyMd("h-c", "code-review")).toContain("内容 1.4.0");
  });

  test("unlock 后恢复可更新；update 之后版本越过原锁定版", async () => {
    await seedNpm();
    await post("/api/v1/skills/code-review/lock", { version: "1.4.0" });
    await get("/api/v1/skills/code-review/versions");
    const un = await post("/api/v1/skills/code-review/unlock");
    expect(un.json()).toMatchObject({
      lockedVersion: null,
      version: "1.4.0",
      status: "update-available",
    });
    const up = await post("/api/v1/skills/code-review/update");
    expect(up.json().skill.version).toBe("1.5.0");
  });

  test("锁定状态与库版本不一致时拒绝补齐（不替用户猜）", async () => {
    await seedNpm();
    skills.setLocked("code-review", "1.4.0"); // 库里是 1.4.2
    const r = await post("/api/v1/skills/code-review/sync", {
      hostIds: ["local"],
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("lock_mismatch");
  });
});

describe("分发达标度：落后与未分发是两回事", () => {
  test("三台环境：一致 / 落后（含手改）/ 没有副本", async () => {
    await seedNpm();
    await post("/api/v1/skills/code-review/distribute", {
      hostIds: ["local", "h-b"],
    });
    expect(await distOf("code-review")).toEqual([
      "local:in-sync",
      "h-b:in-sync",
      "h-c:missing",
    ]);
    // h-b 上被手动改过
    writeFileSync(
      path.join(copyDir("h-b", "code-review"), "references/v.md"),
      "被改过",
    );
    // 清单仍说一致，对账沿用清单；所以用库更新来制造落后
    await post("/api/v1/skills/code-review/update");
    const dist = (await get("/api/v1/skills")).skills[0].dist as Dist[];
    expect(dist.map((d) => [d.hostId, d.state, d.version])).toEqual([
      ["local", "behind", "1.4.2"],
      ["h-b", "behind", "1.4.2"],
      ["h-c", "missing", null],
    ]);
    // 补齐后一致；h-c 仍是未分发，不被 sync 顺手装上
    await post("/api/v1/skills/code-review/sync");
    expect(await distOf("code-review")).toEqual([
      "local:in-sync",
      "h-b:in-sync",
      "h-c:missing",
    ]);
    expect(copyMd("h-b", "code-review")).toContain("内容 1.5.0");
  });

  test("没有任何副本 = 全部 missing（未分发）", async () => {
    await seedNpm();
    const dist = (await get("/api/v1/skills")).skills[0].dist as Dist[];
    expect(dist.every((d) => d.state === "missing")).toBe(true);
  });

  test("同名的手写目录：按内容对比，不一致算落后，同步报告冲突而不覆盖", async () => {
    await seedNpm();
    mkdirSync(copyDir("h-c", "code-review"), { recursive: true });
    writeFileSync(
      path.join(copyDir("h-c", "code-review"), "SKILL.md"),
      md("code-review", "手写"),
    );
    expect((await distOf("code-review"))[2]).toBe("h-c:behind");
    const r = await post("/api/v1/skills/code-review/sync");
    expect(r.json().results).toEqual([
      expect.objectContaining({ hostId: "h-c", status: "conflict" }),
    ]);
    expect(copyMd("h-c", "code-review")).toContain("手写");
  });

  test("探测不到的环境标 missing 并带原因，列表仍然返回；分发到不存在的环境 400", async () => {
    await app.close();
    await setup({ hosts: ["local", "gone"] });
    // gone 的 hub.get 返回 null → 环境不可用
    (
      library as unknown as { deps: { hub: { get: (id: string) => unknown } } }
    ).deps.hub.get = (id: string) =>
      id === "local" ? new HomeEnv(homes.local as string) : null;
    fetcher.publish("npm:@acme/pi-skills", "1.4.2", "code-review");
    await install("npm", "@acme/pi-skills@1.4.2");
    skills.setScope("code-review", "global");
    const dist = (await get("/api/v1/skills")).skills[0].dist as Dist[];
    expect(dist[1]).toMatchObject({
      hostId: "gone",
      state: "missing",
      error: "环境不可用",
    });
    const r = await post("/api/v1/skills/code-review/distribute", {
      hostIds: ["nope"],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("unknown_host");
    expect(
      (await post("/api/v1/skills/code-review/distribute", { hostIds: [] }))
        .statusCode,
    ).toBe(400);
  });

  test("项目级（旧模型）技能不能按环境分发", async () => {
    await seedNpm();
    skills.setScope("code-review", "project");
    const r = await post("/api/v1/skills/code-review/distribute", {
      hostIds: ["local"],
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("project_scope");
  });
});

describe("批量：逐项结果、部分失败不回滚", () => {
  test("update：成功 / 不存在 / 锁定 / 无来源，各自独立", async () => {
    await seedNpm();
    fetcher.publish("npm:other", "1.0.0", "other-skill");
    fetcher.publish("npm:other", "1.1.0", "other-skill");
    await install("npm", "other@1.0.0");
    await post("/api/v1/skills/other-skill/lock", { version: "1.0.0" });
    skills.create("hand-made", "global", "local", [
      { path: "SKILL.md", content: Buffer.from(md("hand-made")) },
    ]);
    const r = await post("/api/v1/skills/batch", {
      names: ["code-review", "ghost-skill", "other-skill", "hand-made"],
      action: "update",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().results).toEqual([
      { name: "code-review", ok: true, changed: true },
      {
        name: "ghost-skill",
        ok: false,
        error: "not_found",
        message: "skill 不存在",
      },
      expect.objectContaining({
        name: "other-skill",
        ok: false,
        error: "locked",
      }),
      expect.objectContaining({
        name: "hand-made",
        ok: false,
        error: "not_updatable",
      }),
    ]);
    // 成功的那项没被后面的失败回滚
    expect(skills.get("code-review")?.version).toBe("1.5.0");
    expect(skills.get("other-skill")?.version).toBe("1.0.0");
  });

  test("disable / enable 只改能力集：文件与环境副本都不动", async () => {
    await seedNpm();
    await post("/api/v1/skills/code-review/distribute", { hostIds: ["local"] });
    const off = await post("/api/v1/skills/batch", {
      names: ["code-review", "ghost-skill"],
      action: "disable",
    });
    expect(off.json().results.map((x: { ok: boolean }) => x.ok)).toEqual([
      true,
      false,
    ]);
    expect(copyMd("local", "code-review")).toContain("内容 1.4.2");
    expect(skills.files("code-review")).toHaveLength(2);
    expect((await get("/api/v1/skills")).skills[0]).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    // 禁用后退出会话能力集，但不算「库里不存在」
    expect(resolveSkills(skills.list(), ["code-review"], [])).toEqual({
      skills: [],
      missing: [],
    });
    await post("/api/v1/skills/batch", {
      names: ["code-review"],
      action: "enable",
    });
    expect(
      resolveSkills(skills.list(), ["code-review"], []).skills,
    ).toHaveLength(1);
  });

  test("uninstall：清理库分发的副本；手写的同名目录保留", async () => {
    await seedNpm();
    await post("/api/v1/skills/code-review/distribute", {
      hostIds: ["local", "h-b"],
    });
    // h-c 上有一个不是同步产物的同名目录
    mkdirSync(copyDir("h-c", "code-review"), { recursive: true });
    writeFileSync(
      path.join(copyDir("h-c", "code-review"), "SKILL.md"),
      md("code-review", "手写"),
    );
    const r = await post("/api/v1/skills/batch", {
      names: ["code-review"],
      action: "uninstall",
    });
    const item = r.json().results[0];
    expect(item).toMatchObject({ ok: true, failed: [] });
    expect([...item.cleaned].sort()).toEqual(["h-b", "local"]);
    expect(existsSync(copyDir("local", "code-review"))).toBe(false);
    expect(existsSync(copyDir("h-b", "code-review"))).toBe(false);
    expect(copyMd("h-c", "code-review")).toContain("手写");
    expect(existsSync(path.join(dir, "skills", "code-review"))).toBe(false);
  });

  test("uninstall：项目级技能清掉被勾选的工作区目录里的副本", async () => {
    fetcher.publish("npm:@acme/pi-skills", "1.4.2", "code-review");
    await install("npm", "@acme/pi-skills@1.4.2");
    expect(skills.get("code-review")?.scope).toBe("project");
    const proj = path.join(dir, "proj");
    mkdirSync(proj);
    const d = directories.create("proj", proj);
    const w = new WorkspaceStore(db).create({ name: "演示" });
    if (!d) throw new Error("目录没建成");
    workspaceDirectories.set(w.id, [d.id]);
    capabilities.set(w.id, "skill", ["code-review"]);
    // 会话创建时的同步：把勾选的项目级技能写进该工作区目录
    await new SkillRuntime({
      skills,
      capabilities,
      load: (m) => library.loadInput(m),
    }).prepare(null, d, new HomeEnv(homes.local as string), [], w.id);
    const copy = path.join(proj, ".agents/skills/yuanshu/code-review");
    expect(existsSync(copy)).toBe(true);

    const r = await post("/api/v1/skills/batch", {
      names: ["code-review"],
      action: "uninstall",
    });
    expect(r.json().results[0]).toMatchObject({ ok: true, failed: [] });
    expect(existsSync(copy)).toBe(false);
  });

  test("参数校验", async () => {
    for (const body of [
      {},
      { names: [], action: "update" },
      { names: ["a"], action: "nuke" },
      { names: [1], action: "update" },
      {
        names: Array.from({ length: 101 }, (_, i) => `n${i}`),
        action: "update",
      },
    ])
      expect((await post("/api/v1/skills/batch", body)).statusCode).toBe(400);
  });
});

describe("旧路由回归与迁移", () => {
  test("旧字段与旧语义保持：source 仍是字符串，手写 skill 无 origin，可编辑", async () => {
    const created = await post("/api/v1/skills", {
      name: "legacy-one",
      scope: "project",
      content: md("legacy-one"),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "legacy-one",
      description: "测试 legacy-one",
      scope: "project",
      source: "local",
      origin: null,
      version: null,
      enabled: true,
      status: "ready",
    });
    const w = await app.inject({
      method: "PUT",
      url: "/api/v1/skills/legacy-one/file",
      payload: { path: "notes.md", content: "x" },
    });
    expect(w.statusCode).toBe(200);
    const list = (await get("/api/v1/skills")).skills[0];
    expect(list).toEqual(
      expect.objectContaining({
        name: "legacy-one",
        source: "local",
        scope: "project",
      }),
    );
    expect(Array.isArray(list.dist)).toBe(true);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/skills/legacy-one" }))
        .statusCode,
    ).toBe(204);
  });

  test("运行时：禁用的技能不会被会话同步；observed 从环境读内容", async () => {
    await seedNpm();
    const ws = directories.create("proj", path.join(dir, "proj"));
    mkdirSync(path.join(dir, "proj"), { recursive: true });
    const runtime = new SkillRuntime({
      skills,
      capabilities,
      load: (m) => library.loadInput(m),
    });
    const env = new HomeEnv(homes.local as string);
    const on = await runtime.prepare(null, ws as NonNullable<typeof ws>, env, [
      "code-review",
    ]);
    expect(on.skills.map((s) => s.name)).toEqual(["code-review"]);
    // 清单里带版本，分发达标度据此显示环境副本的版本
    expect(
      JSON.parse(
        readFileSync(
          path.join(copyDir("local", "code-review"), ".yuanshu-sync.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: "1.4.2" });
    skills.setEnabled("code-review", false);
    const off = await runtime.prepare(null, ws as NonNullable<typeof ws>, env, [
      "code-review",
    ]);
    expect(off.skills).toEqual([]);
    expect(off.report.items).toEqual([]);
  });
});
