// git 面板接口（B42 / P04）：文件浏览器据此给条目着色，Git 面板据此显示分支、看单文件两侧内容、切分支。
// 一律经环境执行器跑 git，本机与 ssh 走同一条路；checkout 是这里唯一会改工作区的接口。
import type { FastifyInstance, FastifyReply } from "fastify";
import type { EnvHub } from "../env/hub.js";
import {
  type GitDirtyMode,
  GitError,
  type GitStatusService,
  isValidBranch,
} from "../git/status.js";

export interface GitApiDeps {
  hub: EnvHub;
  git: GitStatusService;
}

// 只认绝对路径：拼进命令的 -C 与文件路径都得是目标环境上的绝对路径。
const isAbsPath = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/");

const isDirtyMode = (v: unknown): v is GitDirtyMode =>
  v === "stash" || v === "carry" || v === "abort";

/** GitError 自带状态码与原因；其余意外错误按「环境不可达」回 502。 */
function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof GitError)
    return reply
      .code(err.status)
      .send({ kind: err.kind, message: err.message });
  return reply.code(502).send({
    kind: "env_unreachable",
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function gitApi(
  app: FastifyInstance,
  deps: GitApiDeps,
): Promise<void> {
  // 某个路径所在仓库的状态。不是 git 仓库时返回 root: null（前端据此隐藏着色），不是 404。
  app.get<{
    Params: { envId: string };
    Querystring: { path?: string };
  }>("/api/v1/environments/:envId/git/status", async (req, reply) => {
    const env = deps.hub.get(req.params.envId);
    if (!env) return reply.code(404).send({ error: "no_env" });
    const p = req.query.path;
    if (typeof p !== "string" || !p.startsWith("/"))
      return reply.code(400).send({ error: "invalid_path" });
    try {
      return await deps.git.status(env, p);
    } catch {
      // 拿不到状态就当不是仓库：不让文件浏览器因为 git 报错而白屏
      return {
        root: null,
        branch: null,
        detached: false,
        entries: [],
        truncated: false,
      };
    }
  });

  // 本地分支列表与当前分支。非 git 仓库同样是 root: null。
  app.get<{
    Params: { envId: string };
    Querystring: { path?: string };
  }>("/api/v1/environments/:envId/git/branches", async (req, reply) => {
    const env = deps.hub.get(req.params.envId);
    if (!env) return reply.code(404).send({ error: "no_env" });
    const p = req.query.path;
    if (!isAbsPath(p)) return reply.code(400).send({ error: "invalid_path" });
    try {
      return await deps.git.branches(env, p);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 单文件在 HEAD 与工作区两侧的内容。path 只用来找仓库根，file 是要看的那个文件。
  app.get<{
    Params: { envId: string };
    Querystring: { path?: string; file?: string };
  }>("/api/v1/environments/:envId/git/file", async (req, reply) => {
    const env = deps.hub.get(req.params.envId);
    if (!env) return reply.code(404).send({ error: "no_env" });
    const base = req.query.path;
    const file = req.query.file;
    if (!isAbsPath(base) || !isAbsPath(file))
      return reply.code(400).send({ error: "invalid_path" });
    try {
      return await deps.git.fileContent(env, base, file);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 切换分支。dirty 决定工作区有改动时怎么办（abort 拒绝 / stash 先暂存 / carry 带着切）。
  app.post<{
    Params: { envId: string };
    Body: { path?: unknown; branch?: unknown; dirty?: unknown } | undefined;
  }>("/api/v1/environments/:envId/git/checkout", async (req, reply) => {
    const env = deps.hub.get(req.params.envId);
    if (!env) return reply.code(404).send({ error: "no_env" });
    const body = req.body ?? {};
    if (!isAbsPath(body.path))
      return reply.code(400).send({ error: "invalid_path" });
    // 分支名进 shell，先按白名单校验再往下走
    if (typeof body.branch !== "string" || !isValidBranch(body.branch))
      return reply.code(400).send({ error: "invalid_branch" });
    if (!isDirtyMode(body.dirty))
      return reply.code(400).send({ error: "invalid_dirty" });
    try {
      return await deps.git.checkout(env, body.path, body.branch, body.dirty);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
