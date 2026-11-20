// pi 包的 REST（docs/model/plugin.md §4）：列表、安装预览、安装、卸载、整包开关。
// 没有数据要回的动作（安装、卸载、开关）一律 204：前端的 request() 只把 204 当「无响应体」，其余成功状态都会按 JSON 解析。
// 登记写在 pi 自己的 ~/.pi/agent/settings.json（PL5：不建插件表），这里只做入参校验与错误翻译。
import type { FastifyInstance } from "fastify";
import { isObject, str } from "../lib/validate.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import { bad, toHttp } from "./lib/reply.js";

const SOURCE_MAX = 500;

// Fastify 已经解开一次百分号编码；这里不再解码，否则来源里的 `%` 会被二次解码成坏字符。
const sourceParam = (raw: string): string | null => str(raw, SOURCE_MAX);

export async function pluginsApi(
  app: FastifyInstance,
  deps: { runtime: PluginRuntime },
): Promise<void> {
  const { runtime } = deps;

  // 列表直接是数组：前端的行集合就是它，不再套一层键。
  app.get("/api/v1/plugins", async () => runtime.list());

  app.post("/api/v1/plugins/preview", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const source = str(body.source, SOURCE_MAX);
    if (source === null) return bad(reply, "invalid_source");
    try {
      return await runtime.preview(source);
    } catch (err) {
      return toHttp(reply, err);
    }
  });

  app.post("/api/v1/plugins", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const source = str(body.source, SOURCE_MAX);
    if (source === null) return bad(reply, "invalid_source");
    if (body.allowScript !== undefined && typeof body.allowScript !== "boolean")
      return bad(reply, "invalid_allow_script");
    try {
      await runtime.install(source, body.allowScript === true);
      return reply.code(204).send();
    } catch (err) {
      return toHttp(reply, err);
    }
  });

  app.delete<{ Params: { source: string } }>(
    "/api/v1/plugins/:source",
    async (req, reply) => {
      const source = sourceParam(req.params.source);
      if (source === null) return bad(reply, "invalid_source");
      try {
        await runtime.uninstall(source);
        return reply.code(204).send();
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.patch<{ Params: { source: string } }>(
    "/api/v1/plugins/:source",
    async (req, reply) => {
      const source = sourceParam(req.params.source);
      if (source === null) return bad(reply, "invalid_source");
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.enabled !== "boolean")
        return bad(reply, "invalid_enabled");
      try {
        await runtime.toggle(source, body.enabled);
        return reply.code(204).send();
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );
}
