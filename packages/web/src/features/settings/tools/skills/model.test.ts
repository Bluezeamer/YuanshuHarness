import { expect, test } from "vitest";
import type { DistItem, SkillView } from "../../../../api/skillLibrary";
import {
  inferInstall,
  matchesSkill,
  pushTargets,
  scripts,
  statusOf,
} from "./model";

const d = (hostId: string, state: DistItem["state"]): DistItem => ({
  hostId,
  version: state === "missing" ? null : "1",
  hash: null,
  state,
});
const sk = (over: Partial<SkillView> = {}): SkillView => ({
  name: "x-skill",
  description: "",
  scope: "global",
  hash: null,
  origin: { kind: "npm", pkg: "x" },
  version: "1.0.0",
  lockedVersion: null,
  latestVersion: "1.0.0",
  enabled: true,
  status: "ready",
  createdAt: "",
  updatedAt: "",
  dist: [d("a", "in-sync")],
  ...over,
});

test("状态优先级：同步中 > 已禁用 > 锁定 > 可更新 > 落后 > 待分发 > 一致", () => {
  const upd = { status: "update-available" as const };
  expect(statusOf(sk(upd), "同步中").key).toBe("busy");
  expect(statusOf(sk({ ...upd, enabled: false }), null).key).toBe("off");
  expect(statusOf(sk({ lockedVersion: "1.0.0" }), null).text).toBe("锁定");
  expect(statusOf(sk(upd), null).key).toBe("update");
  expect(statusOf(sk({ dist: [d("a", "behind")] }), null).text).toBe("落后 1");
  expect(statusOf(sk({ dist: [d("a", "missing")] }), null).key).toBe("pending");
  expect(statusOf(sk(), null).key).toBe("ok");
});

test("环境落后与未分发是两个概念：只有一个环境缺副本、另一个一致，不算落后也不算未分发", () => {
  const s = sk({ dist: [d("a", "in-sync"), d("b", "missing")] });
  expect(statusOf(s, null).key).toBe("ok");
  expect(statusOf(sk({ dist: [] }), null).key).toBe("pending");
});

test("锁定且环境落后：状态点名落后数，不催更新", () => {
  const s = sk({
    lockedVersion: "1.0.0",
    dist: [d("a", "behind"), d("b", "behind")],
  });
  expect(statusOf(s, null).text).toBe("锁定 · 落后 2");
});

test("能推的环境：落后或缺副本，探测得到，且不是原件所在", () => {
  const s = sk({
    origin: { kind: "observed", hostId: "home", path: "/x" },
    dist: [
      d("home", "missing"),
      d("a", "behind"),
      d("b", "missing"),
      { ...d("c", "missing"), error: "连接未激活" },
      d("e", "in-sync"),
    ],
  });
  expect(pushTargets(s).map((x) => x.hostId)).toEqual(["a", "b"]);
});

test("搜索覆盖名称、描述、来源与版本", () => {
  const s = sk({ name: "code-review", description: "审查改动" });
  const hit = (q: string) => matchesSkill(s, q, {});
  expect(hit("")).toBe(true);
  expect(hit("review")).toBe(true);
  expect(hit("审查")).toBe(true);
  expect(hit("npm")).toBe(true);
  expect(hit("1.0.0")).toBe(true);
  expect(hit("找不到")).toBe(false);
});

test("来源推断：粘贴的文字被识别成来源与版本预览，空输入返回 null，原样交给服务端", () => {
  const base = { kind: "auto" as const, spec: "", hostId: "", path: "" };
  expect(inferInstall(base)).toBeNull();
  expect(
    inferInstall({ ...base, spec: "@acme/pi-skills@1.5.0" }),
  ).toMatchObject({
    ok: true,
    label: "npm · @acme/pi-skills",
    version: "1.5.0",
    source: { kind: "auto", spec: "@acme/pi-skills@1.5.0" },
  });
  expect(
    inferInstall({ ...base, spec: "github.com/acme/kit@feat/x" }),
  ).toMatchObject({
    ok: true,
    label: "git · github.com/acme/kit@feat/x",
    version: "feat/x",
  });
  expect(inferInstall({ ...base, spec: "~/skills/My_Tool" })).toMatchObject({
    ok: true,
    version: null,
  });
  // 网址里的 /tree/ 子目录与用户在候选里选的目录都作为 subdir 带上
  expect(
    inferInstall({
      ...base,
      spec: "https://github.com/a/b/tree/main/skills/x",
    }),
  ).toMatchObject({ source: { kind: "auto", subdir: "skills/x" } });
  expect(
    inferInstall({ ...base, spec: "a/b", subdir: "packages/p" }),
  ).toMatchObject({
    source: { kind: "auto", spec: "a/b", subdir: "packages/p" },
  });
  expect(
    inferInstall({
      ...base,
      kind: "observed",
      hostId: "gpu",
      path: "/opt/a b",
    }),
  ).toMatchObject({
    ok: true,
    source: { kind: "observed", hostId: "gpu", path: "/opt/a b" },
  });
  expect(inferInstall({ ...base, kind: "observed", path: "/opt/x" })).toEqual({
    ok: false,
    message: "先选一个环境",
  });
});

test("识别不了的来源给出支持的写法；常见写法都放行（最终以服务端为准）", () => {
  const base = { kind: "auto" as const, spec: "", hostId: "", path: "" };
  const ok = (spec: string) => inferInstall({ ...base, spec })?.ok;
  expect(ok("not a source!!")).toBe(false);
  expect(ok("")).toBeUndefined();
  for (const good of [
    "pkg",
    "pkg@1.0.0",
    "a/b",
    "a/b@v1",
    "github.com/a/b",
    `${"https"}://github.com/a/b`,
    `${"https"}://gitlab.com/g/sub/repo/-/tree/main/skills/x`,
    "git@github.com:a/b.git",
    "./skills/x",
  ])
    expect(ok(good), good).toBe(true);
});

test("脚本提示：只按文件名认，不探测、不依赖内容", () => {
  const f = (path: string) => ({ path, size: 1 });
  expect(
    scripts([f("SKILL.md"), f("scripts/a.py"), f("v.cjs"), f("notes.txt")]),
  ).toEqual(["scripts/a.py", "v.cjs"]);
  expect(scripts([f("SKILL.md")])).toEqual([]);
});

test("项目级技能不按环境分发：没有副本也不算待分发，落后不催；全局照旧", () => {
  const none = [d("a", "missing")];
  expect(statusOf(sk({ scope: "global", dist: none }), null).key).toBe(
    "pending",
  );
  expect(statusOf(sk({ scope: "project", dist: none }), null)).toMatchObject({
    key: "ok",
    text: "就绪",
  });
  const behind = [d("a", "behind")];
  expect(statusOf(sk({ scope: "global", dist: behind }), null).key).toBe(
    "drift",
  );
  expect(statusOf(sk({ scope: "project", dist: behind }), null).key).toBe("ok");
});
