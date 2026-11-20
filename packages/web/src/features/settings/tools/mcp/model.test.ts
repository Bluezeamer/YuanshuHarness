import { expect, test } from "vitest";
import type { McpView } from "../../../../api/mcpLibrary";
import {
  cmpVersion,
  isUpdatable,
  matchesServer,
  statusOf,
  templateText,
  VERSION_RE,
  versionText,
} from "./model";

const m = (over: Partial<McpView> = {}): McpView => ({
  name: "x-srv",
  description: "d",
  transport: "stdio",
  conf: { command: "npx", args: ["-y", "pkg"], exposure: "direct" },
  source: { runtime: "npm", pkg: "pkg" },
  version: null,
  pinned: false,
  latestVersion: null,
  approval: "ask",
  enabled: true,
  global: false,
  exposure: "direct",
  toolExposure: {},
  timeout: null,
  oauth: null,
  handshake: { ok: true, tools: 1, ms: 5, at: "2026-10-25T00:00:00.000Z" },
  tools: null,
  toolsAt: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

test("版本比较与「可更新」：固定版本低于最新版才标，同版或浮动不标", () => {
  expect(cmpVersion("0.0.83", "0.0.79")).toBeGreaterThan(0);
  expect(cmpVersion("1.10.0", "1.9.0")).toBeGreaterThan(0);
  expect(cmpVersion("1.0.0-rc.1", "1.0.0")).toBe(0);
  expect(isUpdatable(m({ version: "0.0.79", latestVersion: "0.0.83" }))).toBe(
    true,
  );
  expect(isUpdatable(m({ version: "0.0.83", latestVersion: "0.0.83" }))).toBe(
    false,
  );
  expect(isUpdatable(m({ version: null, latestVersion: "1.0.0" }))).toBe(false);
});

test("版本文案：固定带版本，浮动标未固定，http 是远端服务，其余命令不可固定", () => {
  expect(versionText(m())).toBe("浮动 · 未固定");
  expect(versionText(m({ pinned: true, version: "1.0.0" }))).toBe(
    "1.0.0 · 已固定",
  );
  expect(versionText(m({ source: null }))).toBe("不可固定");
  expect(versionText(m({ transport: "http", source: null }))).toBe("远端服务");
});

test("状态：检测中 / 已禁用 / 授权过期 / 不可用 / 未检测 / 可更新 / 就绪", () => {
  const keys = [
    statusOf(m(), "检测中"),
    statusOf(m({ enabled: false }), null),
    statusOf(
      m({
        handshake: {
          ok: false,
          tools: 0,
          ms: 1,
          at: "",
          error: "HTTP 401 未授权",
          authFailed: true,
        },
      }),
      null,
    ),
    statusOf(
      m({
        handshake: {
          ok: false,
          tools: 0,
          ms: 1,
          at: "",
          error: "spawn ENOENT",
        },
      }),
      null,
    ),
    statusOf(m({ handshake: null }), null),
    statusOf(m({ version: "1.0.0", latestVersion: "1.1.0" }), null),
    statusOf(m({ version: "1.1.0", latestVersion: "1.1.0" }), null),
  ].map((s) => s.text);
  expect(keys).toEqual([
    "检测中",
    "已禁用",
    "授权过期",
    "不可用",
    "未检测",
    "可更新",
    "就绪",
  ]);
  // 有新版也不盖过「不可用」：连不上先要处理连不上
  expect(
    statusOf(
      m({
        version: "1.0.0",
        latestVersion: "1.1.0",
        handshake: {
          ok: false,
          tools: 0,
          ms: 1,
          at: "",
          error: "spawn ENOENT",
        },
      }),
      null,
    ).text,
  ).toBe("不可用");
});

test("搜索覆盖名称、描述与目标地址", () => {
  const s = m({ name: "docs-search", description: "内部文档检索" });
  const hit = (q: string) => matchesServer(s, q);
  expect(hit("")).toBe(true);
  expect(hit("docs")).toBe(true);
  expect(hit("检索")).toBe(true);
  expect(hit("npx -y pkg")).toBe(true);
  expect(hit("找不到")).toBe(false);
});

test("版本号格式：x.y.z，可带预发布 / 构建后缀；latest 不行", () => {
  for (const ok of ["1.2.3", "0.0.83", "1.0.0-rc.1", "2.0.0+build.5"])
    expect(VERSION_RE.test(ok), ok).toBe(true);
  for (const bad of ["latest", "1.2", "v1.2.3", "1.2.3.4", ""])
    expect(VERSION_RE.test(bad), bad).toBe(false);
});

test("模板：stdio 带 env，http 带 headers，名称取自键", () => {
  const stdio = JSON.parse(templateText("stdio")).mcpServers;
  expect(Object.keys(stdio)).toEqual(["memory"]);
  expect(stdio.memory.env).toBeTruthy();
  const http = JSON.parse(templateText("http")).mcpServers;
  expect(Object.keys(http)).toEqual(["docs"]);
  expect(http.docs.headers).toBeTruthy();
  expect(http.docs.url).toMatch(/^https:\/\//);
});
