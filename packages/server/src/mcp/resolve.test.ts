import { afterEach, describe, expect, test } from "vitest";
import type { McpServerMeta } from "../store/mcp.js";
import { piMcpConfig } from "./pi-config.js";
import { expandVars, resolveEntries } from "./resolve.js";

const touched: string[] = [];
const setEnv = (k: string, v: string | undefined) => {
  touched.push(k);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

const meta = (name: string, over: Partial<McpServerMeta> = {}) =>
  ({
    name,
    config: { transport: "stdio", command: "x", args: [], env: [] },
    approval: "ask",
    global: false,
    enabled: true,
    exposure: "direct",
    toolExposure: {},
    timeout: null,
    oauth: null,
    description: null,
    handshake: null,
    latestVersion: null,
    tools: null,
    toolsAt: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as McpServerMeta;

describe("resolveEntries", () => {
  test("明文展开 ${VAR}；密码库引用拼上前缀；可混用", () => {
    setEnv("YS_T_HOST", "h1");
    const r = resolveEntries(
      [
        { key: "URL", value: "https://${YS_T_HOST}/x" },
        { key: "Authorization", secretId: "s1", prefix: "Bearer " },
        { key: "PLAIN", value: "a$b!c" },
      ],
      (id) => (id === "s1" ? "tok" : null),
    );
    expect(r).toEqual({
      URL: "https://h1/x",
      Authorization: "Bearer tok",
      PLAIN: "a$b!c",
    });
  });

  test("环境变量没设置、引用的条目已删：抛错并点名是哪一项", () => {
    setEnv("YS_T_NOPE", undefined);
    expect(() =>
      resolveEntries([{ key: "K", value: "${YS_T_NOPE}" }], () => null),
    ).toThrow("K：环境变量 YS_T_NOPE 未设置");
    expect(() =>
      resolveEntries([{ key: "TOKEN", secretId: "gone" }], () => null),
    ).toThrow("TOKEN：引用的密码库条目已不存在");
    expect(() => expandVars("url", "${YS_T_NOPE}")).toThrow("url：");
  });
});

describe("piMcpConfig：一个服务取值失败，不连累别的", () => {
  test("失败的服务被丢掉并记入 failed / errors，其余照常交给 pi", () => {
    setEnv("YS_T_OK", "v");
    setEnv("YS_T_MISSING", undefined);
    const r = piMcpConfig(
      [
        meta("good", {
          config: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "p"],
            env: [{ key: "A", value: "${YS_T_OK}" }],
          },
        }),
        meta("bad-var", {
          config: {
            transport: "stdio",
            command: "npx",
            args: [],
            env: [{ key: "A", value: "${YS_T_MISSING}" }],
          },
        }),
        meta("bad-secret", {
          config: {
            transport: "http",
            url: "https://e.example/mcp",
            headers: [{ key: "Authorization", secretId: "gone" }],
          },
        }),
        meta("web", {
          exposure: "hidden",
          toolExposure: { search: "direct" },
          config: {
            transport: "http",
            url: "https://${YS_T_OK}.example/mcp",
            headers: [],
          },
        }),
      ],
      () => null,
    );
    expect(r.servers.map((s) => s.name)).toEqual(["good", "web"]);
    expect(r.failed.map((f) => f.name)).toEqual(["bad-var", "bad-secret"]);
    expect(r.failed[0]?.message).toContain("YS_T_MISSING");
    expect(r.errors).toHaveLength(2);
    const good = r.servers[0]?.config as { env: Record<string, string> };
    expect(good.env).toEqual({ A: "v" });
    const web = r.servers[1]?.config as unknown as Record<string, unknown>;
    expect(web).toMatchObject({
      url: "https://v.example/mcp",
      exposure: "hidden",
      toolExposure: { search: "direct" },
    });
  });

  test("exposure 一律显式传给 pi（它的缺省是 codemode）", () => {
    const r = piMcpConfig([meta("s")], () => null);
    expect(r.servers[0]?.config).toMatchObject({ exposure: "direct" });
    expect(r.autoEnableCodemode).toBe(false);
  });
});
