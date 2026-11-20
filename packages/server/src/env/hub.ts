import path from "node:path";
import { SshConnection } from "../ssh/connection.js";
import type { AuditLog } from "../store/audit.js";
import type {
  ConnectionRecord,
  ConnectionStore,
} from "../store/connections.js";
import {
  ATTACHMENT_ENV_ID,
  COLLAB_ENV_ID,
  type Environment,
  type EnvironmentStore,
  LOCAL_ENV_ID,
} from "../store/environments.js";
import type { SecretStore } from "../store/secrets.js";
import { LocalEnv } from "./local.js";
import { SshEnv } from "./ssh.js";
import type { EnvStatus, ExecEnv } from "./types.js";
import type { VirtualEnv } from "./virtual.js";
import { VirtualPiEnv } from "./virtual-pi.js";

const signature = (e: Environment, rec: ConnectionRecord | null) =>
  JSON.stringify([
    e.host,
    e.port,
    e.username,
    e.os,
    e.secretId,
    rec?.jumpId ?? null,
    rec?.policy ?? null,
  ]);

// Server 级环境服务（ADR-0034）：每个登记的 ssh 环境一个共享连接，登记信息变了就换新连接。
// 给了 connections 就支持跳板与连接策略；被「断开」的连接保持暂停，直到再次激活才允许建连。
export class EnvHub {
  private readonly local = new LocalEnv();
  private readonly ssh = new Map<string, { sig: string; env: SshEnv }>();
  private readonly paused = new Set<string>();
  // 激活时探测到的系统事实（内核与架构一行），给提示词的「环境信息」段用；只在内存里，重新激活才更新
  private readonly facts = new Map<string, string>();
  // 已激活的连接：登记信息改了也继续用现有连接，改动留到下次激活才生效
  private readonly pinned = new Set<string>();

  constructor(
    private readonly environments: EnvironmentStore,
    private readonly secrets: SecretStore,
    private readonly connections?: ConnectionStore,
    private readonly audit?: AuditLog,
    // 虚拟附件环境由上层装配（根目录来自 data-dir）；没有它就是没接附件功能。
    private readonly virtual?: VirtualEnv,
    // 虚拟协作区环境同上：由 CollabArea 自造（它的根就是那棵目录树）。
    private readonly collabEnv?: VirtualEnv,
    // 数据目录：给 ssh 环境包一层虚拟 ~/.pi（plugin.md §5）；没有就不包。
    private readonly dataDir?: string,
  ) {}

  // 每个 ssh 环境对象一份包装；连接换了（connect 参数变了）就跟着换。
  private readonly virtualPi = new WeakMap<SshEnv, VirtualPiEnv>();

  private wrapped(env: SshEnv): ExecEnv {
    if (this.dataDir === undefined) return env;
    const cached = this.virtualPi.get(env);
    if (cached) return cached;
    const made = new VirtualPiEnv(
      env,
      path.join(this.dataDir, "virtual-pi", env.id),
      async () => env.homedir(),
    );
    this.virtualPi.set(env, made);
    return made;
  }

  /** 环境不存在返回 null。ssh 环境包着虚拟 ~/.pi；本机与两个虚拟环境不动。 */
  get(id: string): ExecEnv | null {
    if (id === ATTACHMENT_ENV_ID) return this.virtual ?? null;
    if (id === COLLAB_ENV_ID) return this.collabEnv ?? null;
    const ssh = this.getSsh(id);
    if (ssh) return this.wrapped(ssh);
    return id === LOCAL_ENV_ID ? this.local : null;
  }

  /** 仅 ssh 环境；本机或不存在返回 null。 */
  getSsh(id: string): SshEnv | null {
    const def = this.environments.get(id);
    const cached = this.ssh.get(id);
    if (!def || def.kind !== "ssh" || def.host === null || def.port === null) {
      cached?.env.close();
      this.ssh.delete(id);
      this.pinned.delete(id);
      return null;
    }
    if (cached && this.pinned.has(id)) return cached.env;
    const rec = this.connections?.get(id) ?? null;
    const sig = signature(def, rec);
    if (cached?.sig === sig) return cached.env;
    cached?.env.close();
    const jumpId = rec?.jumpId ?? null;
    const env = new SshEnv(
      id,
      def.os,
      new SshConnection(
        {
          host: def.host,
          port: def.port,
          username: def.username ?? "",
          secretId: def.secretId,
          keepAlive: rec?.policy.keepAlive ?? true,
          onDrop: (reason) => this.dropped(id, reason),
        },
        this.secrets,
        {
          get: () => this.environments.get(id)?.hostKey ?? null,
          save: (fp) => this.environments.setHostKey(id, fp),
          // 首次见到的指纹：策略为「询问」时不自动记录，记成待核对交给用户
          acceptUnknown: () => (rec?.policy.hostKey ?? "tofu") === "tofu",
          onBlocked: (seen) => this.connections?.setPending(id, seen),
        },
        // 经跳板时由跳板连接开通道代替直连 TCP
        jumpId === null
          ? null
          : async (host, port) => {
              const jump = this.getSsh(jumpId);
              if (!jump) throw new Error("跳板连接不存在");
              return jump.tunnel(host, port);
            },
      ),
      () => {
        if (this.paused.has(id)) {
          const name = this.environments.get(id)?.name ?? id;
          // 这条会原样回给模型：说清楚是用户断开的、别重试、该让用户做什么
          throw new Error(
            `Host "${name}" is disconnected: the user disconnected it, so this is not a transient error. Do not retry. Tell the user to activate "${name}" in Settings → Remote connections, and continue once they confirm.`,
          );
        }
      },
    );
    this.ssh.set(id, { sig, env });
    return env;
  }

  // 已建立的连接被对端或网络断开：状态随连接一起变为未激活，并留一条日志。
  // 只如实记录，不重连；之后若有会话再用到这个环境，仍按 SshEnv 既有的按需建连处理。
  private dropped(id: string, reason: string | null): void {
    this.audit?.record({
      actor: "system",
      kind: "env",
      environmentId: id,
      summary: "连接已断开",
      detail: {
        op: "drop",
        result: "error",
        info: reason ?? "对端关闭了连接",
      },
    });
  }

  status(id: string): EnvStatus | null {
    if (id === LOCAL_ENV_ID) return { id, state: "local" };
    if (id === ATTACHMENT_ENV_ID)
      return this.virtual ? { id, state: "virtual" } : null;
    if (id === COLLAB_ENV_ID)
      return this.collabEnv ? { id, state: "virtual" } : null;
    const status = this.getSsh(id)?.status();
    if (!status) return null;
    return { ...status, hostKey: this.environments.get(id)?.hostKey ?? null };
  }

  /** 激活开始前：解除暂停，丢掉旧连接，让登记信息的改动在本次激活生效。 */
  prepareActivation(id: string): SshEnv | null {
    this.paused.delete(id);
    this.pinned.delete(id);
    this.forget(id);
    return this.getSsh(id);
  }

  /** 激活成功：固定现有连接。 */
  pin(id: string): void {
    this.pinned.add(id);
  }

  /** 断开：关闭连接并暂停，之后任何用法都不会自动重连，直到再次激活。 */
  pause(id: string): void {
    this.pinned.delete(id);
    this.paused.add(id);
    this.ssh.get(id)?.env.close();
  }

  /** 用户主动断开、还没重新激活。网络掉线不算（掉线后下次用到会按需重连）。 */
  isPaused(id: string): boolean {
    return this.paused.has(id);
  }

  /** 激活时记下探测到的系统事实。 */
  setFacts(id: string, probe: string): void {
    this.facts.set(id, probe);
  }

  /** 最近一次激活探测到的系统事实；没探测过是 null。 */
  factsOf(id: string): string | null {
    return this.facts.get(id) ?? null;
  }

  isConnected(id: string): boolean {
    return this.ssh.get(id)?.env.status().state === "connected";
  }

  /** 登记信息已改但连接还是激活时的旧配置（改动待下次激活生效）。 */
  isDirty(id: string): boolean {
    const cached = this.ssh.get(id);
    const def = this.environments.get(id);
    if (!cached || !def || !this.pinned.has(id)) return false;
    return cached.sig !== signature(def, this.connections?.get(id) ?? null);
  }

  /** 环境被删除后释放连接。 */
  forget(id: string): void {
    this.ssh.get(id)?.env.close();
    this.ssh.delete(id);
    this.pinned.delete(id);
    this.paused.delete(id);
    this.facts.delete(id);
  }

  close(): void {
    for (const { env } of this.ssh.values()) env.close();
    this.ssh.clear();
  }
}
