import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memorySwitch } from "../../test/support/plugin-switch.js";
import { HttpError } from "../lib/http-error.js";
import { PluginRuntime } from "../plugins/runtime.js";
import { pluginsApi } from "./plugins.js";

// 包来源用本地目录：不起 npm / git，只走登记与开关这一层。

let dir: string;
let agentDir: string;
let pkgDir: string;
let app: FastifyInstance;

function makePackage(): string {
  const root = path.join(dir, "pkg");
  mkdirSync(path.join(root, "skills", "hello"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "api-sample",
      version: "0.4.0",
      pi: { extensions: ["./index.ts"], skills: ["./skills"] },
    }),
  );
  writeFileSync(path.join(root, "index.ts"), "export default () => {};\n");
  writeFileSync(
    path.join(root, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: 示例\n---\n正文\n",
  );
  return root;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-plugins-api-"));
  agentDir = path.join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  pkgDir = makePackage();
  app = Fastify();
  app.register(pluginsApi, {
    runtime: new PluginRuntime(memorySwitch(), agentDir),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const list = async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/plugins" });
  return res.json() as { source: string; enabled: boolean }[];
};

describe("插件 REST", () => {
  test("列表、预览、安装、开关、卸载", async () => {
    const empty = await app.inject({ method: "GET", url: "/api/v1/plugins" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/plugins/preview",
      payload: { source: pkgDir },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      source: pkgDir,
      version: "0.4.0",
      extensionCount: 1,
      skillCount: 1,
      hasInstallScript: false,
    });

    const install = await app.inject({
      method: "POST",
      url: "/api/v1/plugins",
      payload: { source: pkgDir },
    });
    expect(install.statusCode).toBe(204);

    const [record] = await list();
    // 本地来源会被 pi 规范化成相对 agentDir 的写法，后面的路径参数用同一份字符串
    const source = record?.source as string;
    expect(record).toMatchObject({
      version: "0.4.0",
      enabled: true,
      installed: true,
      extensionCount: 1,
      skillCount: 1,
    });

    const off = await app.inject({
      method: "PATCH",
      url: `/api/v1/plugins/${encodeURIComponent(source)}`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(204);
    expect((await list())[0]?.enabled).toBe(false);

    const on = await app.inject({
      method: "PATCH",
      url: `/api/v1/plugins/${encodeURIComponent(source)}`,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(204);
    expect((await list())[0]?.enabled).toBe(true);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/plugins/${encodeURIComponent(source)}`,
    });
    expect(remove.statusCode).toBe(204);
    expect(await list()).toEqual([]);
  });

  test("入参不对给 400，来源没登记给 404", async () => {
    const bad = [
      { method: "POST" as const, url: "/api/v1/plugins", payload: {} },
      {
        method: "POST" as const,
        url: "/api/v1/plugins/preview",
        payload: { source: "" },
      },
      {
        method: "PATCH" as const,
        url: `/api/v1/plugins/${encodeURIComponent(pkgDir)}`,
        payload: {},
      },
    ];
    for (const req of bad) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(400);
    }

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/v1/plugins/${encodeURIComponent("npm:@none/none")}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  test("来源里没有可加载的内容给 422，内部失败给 502", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/plugins/preview",
      payload: { source: path.join(dir, "不存在") },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({ error: "source_empty" });

    // 业务错误由 toHttp 翻译：502 带错误码与原因，不漏成 500。
    const broken = Fastify();
    broken.register(pluginsApi, {
      runtime: {
        preview: async () => {
          throw new HttpError("preview_failed", "npm 挂了", 502);
        },
      } as unknown as PluginRuntime,
    });
    await broken.ready();
    const res = await broken.inject({
      method: "POST",
      url: "/api/v1/plugins/preview",
      payload: { source: "npm:@none/none" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "preview_failed",
      message: "npm 挂了",
    });
    await broken.close();
  });
});
