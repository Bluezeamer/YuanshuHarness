import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  compareVersions,
  discover,
  FetchError,
  loadLocalSkill,
  PiSkillFetcher,
  pick,
  scopeOf,
} from "./fetch.js";
import { GitRunner } from "./git-fetch.js";

const md = (name: string, body = "正文") =>
  `---\nname: ${name}\ndescription: 测试 ${name}\n---\n\n${body}\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-fetch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (p: string, content: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};

describe("版本比较", () => {
  test("按数值而不是字典序，新的在前", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "v10.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });
});

describe("发现技能", () => {
  test("根目录就是技能；多个技能按推断名挑选，挑不出就报歧义并给候选", () => {
    put(path.join(dir, "one/SKILL.md"), md("only-one"));
    put(path.join(dir, "one/references/a.md"), "x");
    expect(loadLocalSkill(path.join(dir, "one"), "ignored")).toMatchObject({
      name: "only-one",
    });

    put(
      path.join(dir, "pkg/skills/web-prototype/SKILL.md"),
      md("web-prototype"),
    );
    put(path.join(dir, "pkg/skills/brand-audit/SKILL.md"), md("brand-audit"));
    put(path.join(dir, "pkg/package.json"), "{}");
    const found = discover(path.join(dir, "pkg"));
    expect(found.map((c) => c.name).sort()).toEqual([
      "brand-audit",
      "web-prototype",
    ]);
    expect(pick(found, "brand-audit").name).toBe("brand-audit");
    const err = (() => {
      try {
        pick(found, "design-skills");
      } catch (e) {
        return e as FetchError;
      }
      return null;
    })();
    expect(err?.code).toBe("ambiguous");
    expect(err?.candidates).toEqual([
      {
        name: "brand-audit",
        path: "skills/brand-audit",
        description: "测试 brand-audit",
      },
      {
        name: "web-prototype",
        path: "skills/web-prototype",
        description: "测试 web-prototype",
      },
    ]);
    expect(() => pick([], "x")).toThrow(FetchError);
  });

  test("同名多份：就算与来源推断名一致也算歧义，不悄悄取第一份", () => {
    put(path.join(dir, "mono/plugins/a/skills/ctx/SKILL.md"), md("ctx"));
    put(path.join(dir, "mono/plugins/b/skills/ctx/SKILL.md"), md("ctx"));
    const found = discover(path.join(dir, "mono"));
    expect(found.map((c) => c.name)).toEqual(["ctx", "ctx"]);
    const err = (() => {
      try {
        pick(found, "ctx");
      } catch (e) {
        return e as FetchError;
      }
      return null;
    })();
    expect(err?.code).toBe("ambiguous");
    expect(err?.candidates?.map((c) => c.path)).toEqual([
      "plugins/a/skills/ctx",
      "plugins/b/skills/ctx",
    ]);
    // 给了 subdir 就只剩一份
    expect(pick(discover(path.join(dir, "mono"), "plugins/b"), "ctx").rel).toBe(
      "plugins/b/skills/ctx",
    );
  });

  test("subdir 限定发现范围，越界被拒", () => {
    put(path.join(dir, "repo/skills/a/SKILL.md"), md("a"));
    put(path.join(dir, "repo/other/b/SKILL.md"), md("b"));
    expect(
      discover(path.join(dir, "repo"), "skills").map((c) => c.name),
    ).toEqual(["a"]);
    expect(() => scopeOf(path.join(dir, "repo"), "../x")).toThrow(/越出仓库根/);
    expect(() => scopeOf(path.join(dir, "repo"), "/etc")).toThrow(/越出仓库根/);
  });

  test("读目录跳过点开头、node_modules 与符号链接", () => {
    put(path.join(dir, "s/SKILL.md"), md("skip-test"));
    put(path.join(dir, "s/.git/config"), "x");
    put(path.join(dir, "s/node_modules/dep/index.js"), "x");
    put(path.join(dir, "s/scripts/run.sh"), "echo\n");
    const { files } = loadLocalSkill(path.join(dir, "s"), "x");
    expect(files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
  });
});

// 假 npm：registry 目录里是 <pkg>/<版本>/ 的包内容；只实现 view / install。
const FAKE_NPM = `
import { cpSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
const [registry, cmd, ...rest] = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };
if (cmd === "view") {
  const spec = rest[0];
  const at = spec.lastIndexOf("@");
  const [pkg, ver] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, null];
  const base = path.join(registry, pkg);
  if (!existsSync(base)) fail("npm error code E404 404 Not Found - " + pkg);
  const all = readdirSync(base);
  if (ver !== null) {
    if (!all.includes(ver)) fail("npm error code E404 No match found for version " + ver);
    console.log(JSON.stringify(ver));
  } else {
    all.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    console.log(JSON.stringify({ versions: all, "dist-tags": { latest: all.at(-1) } }));
  }
} else if (cmd === "install") {
  const spec = rest[0];
  const prefix = rest[rest.indexOf("--prefix") + 1];
  const at = spec.lastIndexOf("@");
  const pkg = spec.slice(0, at), ver = spec.slice(at + 1);
  mkdirSync(path.join(prefix, "node_modules", path.dirname(pkg)), { recursive: true });
  cpSync(path.join(registry, pkg, ver), path.join(prefix, "node_modules", pkg), { recursive: true });
} else fail("unsupported " + cmd);
`;

describe("PiSkillFetcher（假 npm + 本地 git，不访问外网）", () => {
  let registry: string;
  let fetcher: PiSkillFetcher;
  let gitRoot: string;

  const publish = (pkg: string, ver: string, name: string, body = "正文") => {
    put(
      path.join(registry, pkg, ver, "package.json"),
      JSON.stringify({ name: pkg, version: ver }),
    );
    put(path.join(registry, pkg, ver, "SKILL.md"), md(name, body));
    put(path.join(registry, pkg, ver, "references/r.md"), `r ${ver}`);
  };

  beforeEach(() => {
    registry = path.join(dir, "registry");
    mkdirSync(registry);
    const script = path.join(dir, "fake-npm.mjs");
    writeFileSync(script, FAKE_NPM);
    gitRoot = path.join(dir, "gitroot");
    mkdirSync(gitRoot);
    // 来源地址 git.fake.test/org/repo 指向本地仓库：git 的远端地址由注入的函数决定。
    fetcher = new PiSkillFetcher({
      dir: path.join(dir, "fetch"),
      npmCommand: [process.execPath, script, registry],
      // git.fake.test/org/repo → 本地 gitRoot/org/repo
      gitRemote: (url) => path.join(gitRoot, url.split("/").slice(1).join("/")),
      queryTimeoutMs: 5_000,
      installTimeoutMs: 20_000,
    });
  });

  test("npm：候选版本新到旧，取回指定版本，临时目录清理干净", async () => {
    publish("@acme/pi-skills", "1.4.2", "code-review", "旧");
    publish("@acme/pi-skills", "1.10.0", "code-review", "新");
    publish("@acme/pi-skills", "1.9.0", "code-review");
    const source = { kind: "npm", pkg: "@acme/pi-skills" } as const;
    expect(await fetcher.versions(source)).toEqual([
      "1.10.0",
      "1.9.0",
      "1.4.2",
    ]);
    const got = await fetcher.fetch(source, "1.4.2", "pi-skills");
    expect(got.name).toBe("code-review");
    expect(got.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "package.json",
      "references/r.md",
    ]);
    expect(
      got.files.find((f) => f.path === "SKILL.md")?.content.toString(),
    ).toContain("旧");
    expect(existsSync(path.join(dir, "fetch/npm"))).toBe(false);
  });

  test("npm：版本不存在 → not_found；包不存在 → not_found", async () => {
    publish("code-review", "1.0.0", "code-review");
    const bad = (e: unknown) => (e as FetchError).code;
    await expect(
      fetcher.fetch({ kind: "npm", pkg: "code-review" }, "9.9.9", "x"),
    ).rejects.toSatisfy((e) => bad(e) === "not_found");
    await expect(
      fetcher.versions({ kind: "npm", pkg: "nope" }),
    ).rejects.toSatisfy((e) => bad(e) === "not_found");
  });

  test("npm：无网络给明确原因，卡住的命令超时而不是挂起", async () => {
    const offline = path.join(dir, "offline.mjs");
    writeFileSync(
      offline,
      `console.error("npm error code ENOTFOUND getaddrinfo ENOTFOUND registry.npmjs.org"); process.exit(1);`,
    );
    const hang = path.join(dir, "hang.mjs");
    writeFileSync(hang, `setInterval(() => {}, 1000);`);
    const source = { kind: "npm", pkg: "code-review" } as const;
    await expect(
      new PiSkillFetcher({
        dir: path.join(dir, "f1"),
        npmCommand: [process.execPath, offline],
      }).versions(source),
    ).rejects.toMatchObject({ code: "network" });
    const started = Date.now();
    await expect(
      new PiSkillFetcher({
        dir: path.join(dir, "f2"),
        npmCommand: [process.execPath, hang],
        queryTimeoutMs: 300,
      }).versions(source),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // ---- git：本地仓库当远端 ----

  const gitIn =
    (repo: string) =>
    (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd: repo,
        stdio: "pipe",
      }).toString();

  // 单技能仓库：两次提交、两个 tag；package.json 里有 catalog: 工作区依赖（跑 install 必炸）。
  const makeRepo = () => {
    const repo = path.join(gitRoot, "org/repo");
    mkdirSync(repo, { recursive: true });
    const git = gitIn(repo);
    git("init", "-q", "-b", "main");
    put(
      path.join(repo, "skills/web-prototype/SKILL.md"),
      md("web-prototype", "v1"),
    );
    put(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "repo",
        dependencies: { x: "catalog:" },
        scripts: { prepare: "exit 1" },
      }),
    );
    git("add", ".");
    git("commit", "-q", "-m", "one");
    git("tag", "v1.0.0");
    put(
      path.join(repo, "skills/web-prototype/SKILL.md"),
      md("web-prototype", "v2"),
    );
    git("commit", "-qam", "two");
    git("tag", "v1.1.0");
    git("branch", "feature/x");
    return { repo, first: git("rev-parse", "v1.0.0^{commit}").trim() };
  };

  test("git：缺省 ref 取 HEAD 且带回提交号；tag / 分支 / 提交号都能取", async () => {
    const { repo, first } = makeRepo();
    const source = { kind: "git", url: "git.fake.test/org/repo" } as const;
    const head = gitIn(repo)("rev-parse", "HEAD").trim();

    const cur = await fetcher.fetch(source, "HEAD", "web-prototype");
    expect(cur).toMatchObject({ name: "web-prototype", commit: head });
    expect(
      cur.files.find((f) => f.path === "SKILL.md")?.content.toString(),
    ).toContain("v2");

    const old = await fetcher.fetch(source, "v1.0.0", "web-prototype");
    expect(old.commit).toBe(first);
    expect(
      old.files.find((f) => f.path === "SKILL.md")?.content.toString(),
    ).toContain("v1");

    expect(
      (await fetcher.fetch(source, "feature/x", "web-prototype")).commit,
    ).toBe(head);
    expect((await fetcher.fetch(source, first, "web-prototype")).commit).toBe(
      first,
    );
    // 取回的临时目录用完就删
    expect(
      readdirSync(path.join(dir, "fetch")).filter((n) => n.startsWith("git-")),
    ).toEqual([]);
  });

  test("git：仓库里的 package.json 不执行；候选版本按 ref 形态给", async () => {
    const { repo, first } = makeRepo();
    const source = { kind: "git", url: "git.fake.test/org/repo" } as const;
    const head = gitIn(repo)("rev-parse", "HEAD").trim();
    // 若跑了 install / prepare，这个仓库会以退出码 1 失败。
    await expect(
      fetcher.fetch(source, "HEAD", "web-prototype"),
    ).resolves.toMatchObject({
      name: "web-prototype",
    });
    // 全程没调 npm：调用就会留下标记并失败。
    const marker = path.join(dir, "npm-ran");
    const noisy = path.join(dir, "noisy-npm.mjs");
    writeFileSync(
      noisy,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nprocess.exit(1);`,
    );
    const onlyGit = new PiSkillFetcher({
      dir: path.join(dir, "fetch-git-only"),
      npmCommand: [process.execPath, noisy],
      gitRemote: (url) => path.join(gitRoot, url.split("/").slice(1).join("/")),
      installTimeoutMs: 20_000,
    });
    await expect(
      onlyGit.fetch(source, "HEAD", "web-prototype"),
    ).resolves.toMatchObject({ name: "web-prototype" });
    expect(existsSync(marker)).toBe(false);
    expect(await fetcher.versions(source)).toEqual([head]);
    expect(await fetcher.versions({ ...source, ref: "main" })).toEqual([head]);
    expect(await fetcher.versions({ ...source, ref: first })).toEqual([first]);
    expect(await fetcher.versions({ ...source, ref: "v1.0.0" })).toEqual([
      "v1.1.0",
      "v1.0.0",
    ]);
  });

  test("git：只取到单个提交（浅取回），不是整段历史", async () => {
    const repo = path.join(gitRoot, "org/history");
    mkdirSync(repo, { recursive: true });
    const git = gitIn(repo);
    git("init", "-q", "-b", "main");
    for (let i = 0; i < 3; i++) {
      put(path.join(repo, `f${i}.txt`), "x");
      git("add", ".");
      git("commit", "-q", "-m", `c${i}`);
    }
    const root = path.join(dir, "shallow");
    mkdirSync(root);
    const runner = new GitRunner({
      remote: () => path.join(gitRoot, "org/history"),
      fetchTimeoutMs: 20_000,
    });
    await runner.fetch("git.fake.test/org/history", "HEAD", root);
    // 只取到目标提交本身：历史深度 1，且是浅仓库。
    expect(gitIn(root)("rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(existsSync(path.join(root, ".git/shallow"))).toBe(true);
  });

  test("git：多个技能报歧义并给候选，带 subdir 再试成功", async () => {
    const repo = path.join(gitRoot, "org/multi");
    mkdirSync(repo, { recursive: true });
    const git = gitIn(repo);
    git("init", "-q", "-b", "main");
    put(
      path.join(repo, "packages/pi/skills/context7-docs/SKILL.md"),
      md("context7-docs"),
    );
    put(
      path.join(repo, "plugins/a/skills/context7-mcp/SKILL.md"),
      md("context7-mcp"),
    );
    put(
      path.join(repo, "plugins/b/skills/context7-mcp/SKILL.md"),
      md("context7-mcp"),
    );
    git("add", ".");
    git("commit", "-q", "-m", "one");
    const source = { kind: "git", url: "git.fake.test/org/multi" } as const;

    const err = await fetcher
      .fetch(source, "HEAD", "multi")
      .catch((e: FetchError) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe("ambiguous");
    expect((err as FetchError).candidates?.map((c) => c.path)).toEqual([
      "packages/pi/skills/context7-docs",
      "plugins/a/skills/context7-mcp",
      "plugins/b/skills/context7-mcp",
    ]);
    expect((err as FetchError).candidates?.[0]).toMatchObject({
      name: "context7-docs",
      description: "测试 context7-docs",
    });

    const got = await fetcher.fetch(
      { ...source, subdir: "packages/pi/skills/context7-docs" },
      "HEAD",
      "multi",
    );
    expect(got.name).toBe("context7-docs");
    expect(got.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  test("git：subdir 越界与坏 ref 直接拒绝，不做取回", async () => {
    makeRepo();
    const source = { kind: "git", url: "git.fake.test/org/repo" } as const;
    await expect(
      fetcher.fetch({ ...source, subdir: "../etc" }, "HEAD", "x"),
    ).rejects.toBeInstanceOf(FetchError);
    await expect(
      fetcher.fetch(source, "v9.9.9", "web-prototype"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      fetcher.fetch(
        { kind: "git", url: "git.fake.test/org/missing" },
        "HEAD",
        "x",
      ),
    ).rejects.toBeInstanceOf(FetchError);
    await expect(
      fetcher.versions({ kind: "git", url: "git.fake.test/org/missing" }),
    ).rejects.toBeInstanceOf(FetchError);
  });
});
