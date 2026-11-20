// 按 (环境, 目录) 取画布仓库：同一对复用同一个实例，串行队列与待提交来源才不会分裂。
// 远程（ssh）环境的 `.canvas/` 在 Server 本机有一份权威副本，远端由镜像在后台推（canvas.md §10 本地优先）。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { SERVER_HOST_ID } from "../env/host-id.js";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import { hostLabel } from "../session/address.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import { CanvasGit } from "./git.js";
import { CANVAS_DIR } from "./layout.js";
import { CanvasMirror, type MirrorStatus } from "./mirror.js";
import { ReplicaEnv } from "./replica-env.js";
import { CanvasError, CanvasRepo } from "./repo.js";

export type { CanvasRepo };
export { CanvasError };

export interface CanvasServiceDeps {
  env(envId: string): ExecEnv | null;
  commitDelayMs?: number;
  /**
   * 环境 id → 给 agent 看的主机名，相对 `homeEnvId`（画布所在的环境）：它叫 local，
   * Server 本机不是它时叫 server，其余是连接名。与 session/address.ts 的 hostLabel 同一份规则。
   */
  hostName?(envId: string, homeEnvId: string): string;
  /** agent 给的主机名或 id → 环境 id（相对画布所在的环境解析）；没有这台主机或重名返回 null */
  hostId?(target: string, homeEnvId: string): string | null;
  /** 远程环境的画布副本放在哪（`<dataDir>/canvas`）；不给就不做本地优先，直接读写远端 */
  replicaDir?: string;
}

/**
 * 画布里的主机名相对画布所在的环境：那个环境叫 local，Server 本机不是它时叫 server，其余是连接名
 * （写不进地址的连接名退回环境 id）。与会话地址簿同一份规则（session/address.ts 的 hostLabel）。
 */
export function canvasHostName(
  envs: () => { id: string; name: string }[],
  envId: string,
  homeEnvId: string,
): string {
  return hostLabel(envId, {
    primaryEnvId: homeEnvId,
    connectionName: (id) => envs().find((e) => e.id === id)?.name,
  });
}

/** agent 给的主机名或环境 id → 环境 id（同样相对画布所在的环境）；找不到或重名返回 null。 */
export function canvasHostId(
  envs: () => { id: string; name: string }[],
  target: string,
  homeEnvId: string,
): string | null {
  const lower = target.toLowerCase();
  // 先按画布里的名字（local / server / 连接名），再看环境 id：名字优先，
  // 免得 local 这个名字同时是环境 id 时被它劫持（同 session/address.ts）。
  const byLabel = envs().filter(
    (e) => canvasHostName(envs, e.id, homeEnvId).toLowerCase() === lower,
  );
  if (byLabel.length === 1) return (byLabel[0] as { id: string }).id;
  if (byLabel.length > 1) return null;
  const byId = envs().find((e) => e.id.toLowerCase() === lower);
  if (byId) return byId.id;
  // server 永远是 Server 本机（画布就在本机时它与 local 是同一台）
  return lower === SERVER_HOST_ID && envs().some((e) => e.id === LOCAL_ENV_ID)
    ? LOCAL_ENV_ID
    : null;
}

interface Entry {
  repo: CanvasRepo;
  /** 读写这个目录的画布用的环境：远程环境是副本环境，其余就是原环境 */
  env: ExecEnv;
  mirror: CanvasMirror | null;
}

export class CanvasService {
  private readonly entries = new Map<string, Entry>();
  private readonly local = new LocalEnv();

  constructor(private readonly deps: CanvasServiceDeps) {}

  /** agent 引用别的主机上的文件时给的主机名或 id → 环境 id；`homeEnvId` 是画布所在的环境 */
  hostId(target: string, homeEnvId: string): string | null {
    return (
      this.deps.hostId?.(target, homeEnvId) ??
      (this.deps.env(target) ? target : null)
    );
  }

  repo(envId: string, projectDir: string): CanvasRepo {
    return this.entry(envId, projectDir).repo;
  }

  /** 接口读写这个目录的画布（含资源文件）用的环境 */
  envFor(envId: string, projectDir: string): ExecEnv {
    return this.entry(envId, projectDir).env;
  }

  /** 副本已经是权威：这时不必再为校验目录之类的事去问远端 */
  adopted(envId: string, projectDir: string): boolean {
    return this.peek(envId, projectDir)?.mirror?.adopted ?? false;
  }

  /** 远端同步的状态；没有副本（本机环境）返回 null */
  mirrorStatus(envId: string, projectDir: string): MirrorStatus | null {
    return this.peek(envId, projectDir)?.mirror?.status() ?? null;
  }

  /** agent 要读远端的文件之前：把还没推过去的改动推完（最多等 timeoutMs，远端不通就放行）。 */
  async settle(
    envId: string,
    projectDir: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.peek(envId, projectDir)?.mirror?.settle(timeoutMs);
  }

  /** 退出前：先把还在去抖的提交冲掉（它会改副本），再尽量把没推的推完，最后停掉后台推送。 */
  async close(timeoutMs = 3000): Promise<void> {
    const entries = [...this.entries.values()];
    await Promise.allSettled(entries.map((e) => e.repo.settle()));
    const mirrors = entries.flatMap((e) => (e.mirror ? [e.mirror] : []));
    await Promise.allSettled(mirrors.map((m) => m.settle(timeoutMs)));
    for (const m of mirrors) m.close();
  }

  /** 已建的条目；还没建但本机已有这个目录的副本（上次没推完就退出了）也建出来。 */
  private peek(envId: string, rawDir: string): Entry | null {
    const env = this.deps.env(envId);
    if (env === null || !pathOf(env).isAbsolute(rawDir)) return null;
    const projectDir = pathOf(env).resolve(rawDir);
    const hit = this.entries.get(`${envId}\0${projectDir}`);
    if (hit) return hit;
    const dir = this.replicaBase(envId, projectDir);
    if (dir === null || !existsSync(path.join(dir, "mirror.json"))) return null;
    try {
      return this.entry(envId, projectDir);
    } catch {
      return null;
    }
  }

  private entry(envId: string, rawDir: string): Entry {
    const env = this.deps.env(envId);
    if (env === null) throw new CanvasError("env_unavailable", "环境不可用");
    // 目录在这里只做形状校验：存不存在、是不是目录由接口层 stat 判断。
    if (
      typeof rawDir !== "string" ||
      rawDir === "" ||
      rawDir.includes("\0") ||
      !pathOf(env).isAbsolute(rawDir)
    )
      throw new CanvasError("invalid_path", "目录必须是绝对路径");
    // 同一个目录的不同写法（结尾的 /、a/../b）要落到同一个实例与同一份副本上
    const projectDir = pathOf(env).resolve(rawDir);
    const key = `${envId}\0${projectDir}`;
    const hit = this.entries.get(key);
    if (hit) return hit;
    const base =
      env.kind === "ssh" ? this.replicaBase(envId, projectDir) : null;
    let view = env;
    let mirror: CanvasMirror | null = null;
    if (base !== null) {
      const remoteRoot = pathOf(env).join(projectDir, CANVAS_DIR);
      const localRoot = path.join(base, CANVAS_DIR);
      mirror = new CanvasMirror({
        remote: env,
        remoteRoot,
        local: this.local,
        localRoot,
        metaFile: path.join(base, "mirror.json"),
        onAdopted: () =>
          new CanvasGit(env, remoteRoot).excludeFromProject(projectDir),
      });
      view = new ReplicaEnv({
        remote: env,
        local: this.local,
        remoteRoot,
        localRoot,
        mirror,
      });
    }
    const repo = new CanvasRepo(view, projectDir, {
      ...(this.deps.commitDelayMs === undefined
        ? {}
        : { commitDelayMs: this.deps.commitDelayMs }),
      envOf: (id) => this.deps.env(id),
      // 画布里的主机名相对它自己的环境：同一个画布由谁打开，名字都一样
      ...(this.deps.hostName
        ? { hostLabel: (id: string) => this.deps.hostName?.(id, envId) ?? id }
        : {}),
      mirrored: mirror !== null,
    });
    const made = { repo, env: view, mirror };
    this.entries.set(key, made);
    // 上次没推完就退出的，这次起来接着推
    if (mirror?.adopted) void mirror.ready().catch(() => {});
    return made;
  }

  /** 这个 (环境, 目录) 的副本目录；没配 replicaDir 时没有 */
  private replicaBase(envId: string, projectDir: string): string | null {
    if (this.deps.replicaDir === undefined) return null;
    const safe = envId.replace(/[^\w.-]/g, "_");
    const hash = createHash("sha1")
      .update(projectDir)
      .digest("hex")
      .slice(0, 12);
    return path.join(this.deps.replicaDir, safe, hash);
  }
}
