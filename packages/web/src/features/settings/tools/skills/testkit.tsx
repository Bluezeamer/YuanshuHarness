// 仅测试使用：技能库的带状态假服务端，语义对照 server 的 api/skills-library.ts 与 skills/library.ts。

import { fireEvent, screen } from "@testing-library/react";
import type {
  DistItem,
  SkillOrigin,
  SkillScope,
  SkillView,
} from "../../../../api/skillLibrary";
import { toolsRoutes } from "../builtin/testkit";
import { fakeFetch, mountPage, type Route, reply } from "../common/testkit";

export interface FakeSkill {
  name: string;
  description: string;
  scope: SkillScope;
  origin: SkillOrigin | null;
  version: string | null;
  lockedVersion: string | null;
  latestVersion: string | null;
  /** 候选版本，新的在前。 */
  candidates: string[];
  enabled: boolean;
  createdAt: string;
  /** 环境 id → 该环境上副本的版本（null = 没有副本）。 */
  copies: Record<string, string | null>;
  files: Record<string, string>;
}

const ENVS = ["local", "gpu"];
let seq = 0;

export const skill = (
  name: string,
  over: Partial<FakeSkill> = {},
): FakeSkill => ({
  name,
  description: `${name} 的描述`,
  scope: "global",
  origin: { kind: "npm", pkg: `@acme/${name}` },
  version: "1.0.0",
  lockedVersion: null,
  latestVersion: "1.0.0",
  candidates: ["1.0.0"],
  enabled: true,
  createdAt: new Date(
    Date.UTC(2026, 9, 1, 0, 0, 0) - ++seq * 1000,
  ).toISOString(),
  copies: { local: over.version ?? "1.0.0", gpu: over.version ?? "1.0.0" },
  files: { "SKILL.md": `---\nname: ${name}\n---\n正文 ${name}\n` },
  ...over,
});

/** 与设计稿种子同形：6 个技能 · 可更新 2 · 环境落后 1 · 未分发 1。 */
export const seedSkills = (): FakeSkill[] => [
  skill("code-review", {
    version: "1.4.2",
    latestVersion: "1.5.0",
    candidates: ["1.5.0", "1.4.2", "1.4.1", "1.4.0"],
    files: {
      "SKILL.md": "---\nname: code-review\n---\n评审规程\n",
      "references/severity.md": "P0 阻断：必须修复才能合并\n",
      "scripts/check.py": 'print("a".replace("\\n", " "))\n',
    },
  }),
  skill("k8s-ops", {
    origin: { kind: "git", url: "github.com/acme/k8s-ops", ref: "v0.9.1" },
    version: "v0.9.1",
    latestVersion: "v0.9.1",
    candidates: ["v0.9.1", "v0.9.0", "v0.8.6"],
    copies: { local: "v0.9.1", gpu: "v0.8.6" },
  }),
  skill("pdf-tools", { version: "2.3.0", latestVersion: "2.3.0" }),
  skill("data-viz", {
    origin: { kind: "git", url: "github.com/acme/data-viz", ref: "v1.0.0" },
    version: "v1.0.0",
    latestVersion: "v1.1.0",
    candidates: ["v1.1.0", "v1.0.0"],
  }),
  skill("local-notes", {
    description: "",
    origin: { kind: "dir", path: "/srv/skills/local-notes" },
    version: null,
    latestVersion: null,
    copies: { local: "—", gpu: null },
  }),
  skill("release-notes", {
    copies: { local: null, gpu: null },
  }),
];

const cmp = (a: string, b: string) =>
  a.replace(/^v/, "").localeCompare(b.replace(/^v/, ""), undefined, {
    numeric: true,
  });

const distOf = (s: FakeSkill): DistItem[] =>
  ENVS.map((hostId): DistItem => {
    const v = s.copies[hostId] ?? null;
    if (v === null)
      return { hostId, version: null, hash: null, state: "missing" };
    // 没有版本的来源（本地目录）副本只要存在就算一致
    const same = s.version === null || v === s.version;
    return {
      hostId,
      version: v,
      hash: "h",
      state: same ? "in-sync" : "behind",
    };
  });

export const viewOf = (s: FakeSkill, withDist = true): SkillView => ({
  name: s.name,
  description: s.description,
  scope: s.scope,
  hash: "h",
  origin: s.origin,
  version: s.version,
  lockedVersion: s.lockedVersion,
  latestVersion: s.latestVersion,
  enabled: s.enabled,
  // 与服务端 statusOf 同一规则：锁定期间不催更新
  status: !s.enabled
    ? "disabled"
    : s.lockedVersion === null &&
        s.version !== null &&
        s.latestVersion !== null &&
        cmp(s.latestVersion, s.version) > 0
      ? "update-available"
      : "ready",
  createdAt: s.createdAt,
  updatedAt: s.createdAt,
  ...(withDist ? { dist: s.scope === "global" ? distOf(s) : [] } : {}),
});

const slug = (x: string) =>
  x
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const err = (status: number, error: string, message: string) =>
  reply(status, { error, message });

/** 路由：/skills 全套 + /connections（环境名）。 */
export function skillsRoutes(initial: FakeSkill[] = seedSkills()) {
  const state = { skills: structuredClone(initial) };
  const get = (n: string) => state.skills.find((s) => s.name === n);
  // 在库里换版本的统一出口：库版本变了，环境副本不动（分发是单独一步）
  const moveTo = (s: FakeSkill, v: string) => {
    s.version = v;
  };

  const route: Route = (method, full, body) => {
    const [path = "", query = ""] = full.split("?");
    if (method === "GET" && path === "/api/v1/connections")
      return reply(200, {
        server: { host: "server", environmentId: "local", label: "本机" },
        connections: [{ id: "gpu", label: "GPU 训练机" }],
      });
    if (method === "GET" && path === "/api/v1/skills")
      return reply(200, { skills: state.skills.map((s) => viewOf(s)) });
    if (method === "POST" && path === "/api/v1/skills/install") {
      const src = (body as { source: Record<string, string> }).source;
      let name = "";
      let origin: SkillOrigin;
      let version: string | null = null;
      if (src.kind === "auto") {
        const spec = src.spec ?? "";
        // 约定：含 multi 的仓库里有两个技能，不带 subdir 时要选
        if (spec.includes("multi") && !src.subdir)
          return new Response(
            JSON.stringify({
              error: "ambiguous_skills",
              message: "来源里有多个技能",
              candidates: [
                { name: "alpha", path: "skills/alpha", description: "第一个" },
                { name: "beta", path: "skills/beta", description: "第二个" },
              ],
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        if (/^(\.{1,2}\/|\/|~\/)/.test(spec)) {
          origin = { kind: "dir", path: spec };
          name = slug(spec.split("/").pop() ?? "");
        } else if (
          /^@?[a-z0-9][\w.-]*(\/[\w.-]+)?(@[0-9][\w.+-]*)?$/.test(spec) &&
          !spec.includes("github")
        ) {
          const at = spec.lastIndexOf("@");
          const pkg = at > 0 ? spec.slice(0, at) : spec;
          origin = { kind: "npm", pkg };
          version = at > 0 ? spec.slice(at + 1) : "3.0.0";
          name = slug(pkg.split("/").pop() ?? "");
        } else {
          const at = spec.lastIndexOf("@");
          const repo = (at > 0 ? spec.slice(0, at) : spec)
            .replace(/^https?:\/\//, "")
            .replace(/\.git$/, "");
          origin = {
            kind: "git",
            url: repo,
            ...(at > 0 ? { ref: spec.slice(at + 1) } : {}),
            ...(src.subdir ? { subdir: src.subdir } : {}),
          };
          version =
            at > 0
              ? spec.slice(at + 1)
              : "0123456789abcdef0123456789abcdef01234567";
          name = src.subdir
            ? slug(src.subdir.split("/").pop() ?? "")
            : slug(repo.split("/").pop() ?? "");
        }
      } else {
        origin = {
          kind: "observed",
          hostId: src.hostId ?? "",
          path: src.path ?? "",
        };
        name = slug((src.path ?? "").split("/").pop() ?? "");
      }
      if (get(name))
        return err(409, "name_exists", `库中已有同名技能：${name}`);
      const s = skill(name, {
        origin,
        version,
        latestVersion: version,
        candidates: version ? [version] : [],
        description: "来自 SKILL.md 的描述",
        copies: { local: null, gpu: null },
        createdAt: new Date().toISOString(),
      });
      state.skills.push(s);
      return reply(201, viewOf(s));
    }
    if (method === "POST" && path === "/api/v1/skills/batch") {
      const b = body as { names: string[]; action: string };
      const results = b.names.map((name) => {
        const s = get(name);
        if (!s)
          return {
            name,
            ok: false,
            error: "not_found",
            message: "skill 不存在",
          };
        if (b.action === "update") {
          if (s.lockedVersion !== null)
            return {
              name,
              ok: false,
              error: "locked",
              message: `已锁定在 ${s.lockedVersion}，先解除锁定再更新`,
            };
          const changed =
            s.latestVersion !== null && s.latestVersion !== s.version;
          if (changed && s.latestVersion) moveTo(s, s.latestVersion);
          return { name, ok: true, changed };
        }
        if (b.action === "uninstall") {
          const cleaned =
            s.origin?.kind === "observed"
              ? []
              : ENVS.filter((h) => s.copies[h] != null);
          state.skills = state.skills.filter((x) => x.name !== name);
          return {
            name,
            ok: true,
            cleaned,
            failed: [],
            ...(s.origin?.kind === "observed" ? { keptInPlace: "/x" } : {}),
          };
        }
        s.enabled = b.action === "enable";
        return { name, ok: true };
      });
      return reply(200, { results });
    }
    const m = /^\/api\/v1\/skills\/([^/]+)(?:\/(\w+))?$/.exec(path);
    if (!m) return undefined;
    const s = get(decodeURIComponent(m[1] ?? ""));
    if (!s) return err(404, "not_found", "skill 不存在");
    const sub = m[2];
    if (method === "GET" && !sub)
      return reply(200, {
        skill: viewOf(s),
        files: Object.entries(s.files).map(([p, c]) => ({
          path: p,
          size: c.length,
        })),
      });
    if (method === "GET" && sub === "file") {
      const p = new URLSearchParams(query).get("path") ?? "";
      const c = s.files[p];
      return c === undefined
        ? reply(404, { error: "not_found" })
        : reply(200, { path: p, content: c });
    }
    if (method === "GET" && sub === "versions") {
      const tracked = s.origin?.kind === "npm" || s.origin?.kind === "git";
      const list = tracked ? s.candidates : [];
      return reply(200, {
        name: s.name,
        tracked,
        current: s.version,
        locked: s.lockedVersion,
        latest: list[0] ?? null,
        versions: list.map((v) => ({
          version: v,
          current: v === s.version,
          latest: v === list[0],
        })),
      });
    }
    if (method === "PATCH" && !sub) {
      const b = body as { scope?: SkillScope };
      if (b.scope) s.scope = b.scope;
      // 与服务端一致：旧的 PATCH 路由返回的视图不带分发状态
      return reply(200, viewOf(s, false));
    }
    if (method !== "POST") return undefined;
    if (sub === "update") {
      if (s.lockedVersion !== null)
        return err(
          409,
          "locked",
          `已锁定在 ${s.lockedVersion}，先解除锁定再更新`,
        );
      const changed = s.latestVersion !== null && s.latestVersion !== s.version;
      if (changed && s.latestVersion) moveTo(s, s.latestVersion);
      return reply(200, { skill: viewOf(s), changed });
    }
    if (sub === "lock") {
      const v = (body as { version?: string }).version;
      if (!v || !s.candidates.includes(v))
        return err(400, "invalid_version", "version 格式不合法");
      moveTo(s, v);
      s.lockedVersion = v;
      return reply(200, viewOf(s));
    }
    if (sub === "unlock") {
      s.lockedVersion = null;
      return reply(200, viewOf(s));
    }
    if (sub === "sync" || sub === "distribute") {
      const ids = (body as { hostIds?: string[] }).hostIds;
      const targets =
        ids ??
        distOf(s)
          .filter((d) => d.state === "behind")
          .map((d) => d.hostId);
      // 只把库里现有版本推出去，从不联网换版本：锁定版永远不会被越过
      for (const h of targets) s.copies[h] = s.version ?? "—";
      return reply(200, {
        skill: viewOf(s),
        results: targets.map((hostId) => ({ hostId, status: "updated" })),
      });
    }
    return undefined;
  };
  return { route, state };
}

/** 挂载整页并切到技能页签。 */
export async function mountSkills(initial?: FakeSkill[]) {
  const api = skillsRoutes(initial);
  const fake = fakeFetch(api.route, toolsRoutes().route);
  await mountPage(fake);
  fireEvent.click(screen.getByRole("tab", { name: /技能/ }));
  await screen.findByRole("complementary", { name: "技能" });
  return { fake, api };
}
