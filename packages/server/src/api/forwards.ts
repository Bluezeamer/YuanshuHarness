// 服务转发接口（工作区级）：列出、开启、关闭。转发本身在 forward/service.ts，认证由 /api/v1 作用域统一施加。
import type { FastifyInstance } from "fastify";
import {
  resolveTarget,
  TargetError,
  type TargetOptions,
} from "../browser/net/target.js";
import { SERVER_HOST_ID } from "../env/host-id.js";
import type { ForwardService, ForwardView } from "../forward/service.js";
import { HttpError } from "../lib/http-error.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import { bad, notFound, toHttp } from "./lib/reply.js";

/** 与端口列表同一种写法：用户能直接在地址栏输入的目标（本机用 server 这个别名），前端行上的名字共用它。 */
const withTarget = (v: ForwardView) => ({
  ...v,
  target: `${v.envId === LOCAL_ENV_ID ? SERVER_HOST_ID : v.envId}:${v.port}`,
});

export function forwardsApi(
  app: FastifyInstance,
  opts: {
    forwards: Pick<ForwardService, "list" | "open" | "close">;
    /** 与地址栏同一套目标解析：主机名怎么对应环境、裸端口落在哪个环境 */
    targetOptions(workspaceKey: string): TargetOptions;
  },
): void {
  app.get<{ Params: { wid: string } }>(
    "/api/v1/workspaces/:wid/forwards",
    async (req) => ({
      forwards: opts.forwards.list(req.params.wid).map(withTarget),
    }),
  );

  // body.target 写成 `3000`（工作区主目录所在的主机）、`local:3000`、`server:3000`、`box:8080`，与地址栏一致；
  // 不探测此刻有没有在监听
  app.post<{
    Params: { wid: string };
    Body: { target?: unknown };
  }>("/api/v1/workspaces/:wid/forwards", async (req, reply) => {
    const raw = req.body?.target;
    if (typeof raw !== "string" || raw.trim() === "")
      return bad(reply, "bad_request", "要指定转发哪个端口");
    const text = raw.trim();
    try {
      const target = resolveTarget(
        /^[0-9]{1,5}$/.test(text) ? `local:${text}` : text,
        opts.targetOptions(req.params.wid),
      );
      if (target.kind !== "service")
        return bad(
          reply,
          "bad_target",
          "要写成 端口 或 host:端口，例如 3000、local:3000、server:3000、box:8080",
        );
      return withTarget(
        await opts.forwards.open(req.params.wid, target.envId, target.port),
      );
    } catch (err) {
      if (err instanceof TargetError)
        return bad(reply, "bad_target", err.message);
      if (err instanceof HttpError) return toHttp(reply, err);
      throw err;
    }
  });

  app.delete<{ Params: { wid: string; id: string } }>(
    "/api/v1/workspaces/:wid/forwards/:id",
    async (req, reply) => {
      const closed = await opts.forwards.close(req.params.wid, req.params.id);
      if (!closed) return notFound(reply);
      return reply.code(204).send();
    },
  );
}
