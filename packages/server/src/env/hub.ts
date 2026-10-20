import { SshConnection } from "../ssh/connection.js";
import {
  type Environment,
  type EnvironmentStore,
  LOCAL_ENV_ID,
} from "../store/environments.js";
import type { SecretStore } from "../store/secrets.js";
import { LocalEnv } from "./local.js";
import { SshEnv } from "./ssh.js";
import type { EnvStatus, ExecEnv } from "./types.js";

const signature = (e: Environment) =>
  JSON.stringify([e.host, e.port, e.username, e.os, e.secretId]);

// Server 级环境服务（ADR-0034）：每个登记的 ssh 环境一个共享连接，登记信息变了就换新连接。
export class EnvHub {
  private readonly local = new LocalEnv();
  private readonly ssh = new Map<string, { sig: string; env: SshEnv }>();

  constructor(
    private readonly environments: EnvironmentStore,
    private readonly secrets: SecretStore,
  ) {}

  /** 环境不存在返回 null。 */
  get(id: string): ExecEnv | null {
    return this.getSsh(id) ?? (id === LOCAL_ENV_ID ? this.local : null);
  }

  /** 仅 ssh 环境；本机或不存在返回 null。 */
  getSsh(id: string): SshEnv | null {
    const def = this.environments.get(id);
    const cached = this.ssh.get(id);
    if (!def || def.kind !== "ssh" || def.host === null || def.port === null) {
      cached?.env.close();
      this.ssh.delete(id);
      return null;
    }
    const sig = signature(def);
    if (cached?.sig === sig) return cached.env;
    cached?.env.close();
    const env = new SshEnv(
      id,
      def.os,
      new SshConnection(
        {
          host: def.host,
          port: def.port,
          username: def.username ?? "",
          secretId: def.secretId,
        },
        this.secrets,
        {
          get: () => this.environments.get(id)?.hostKey ?? null,
          save: (fp) => this.environments.setHostKey(id, fp),
        },
      ),
    );
    this.ssh.set(id, { sig, env });
    return env;
  }

  status(id: string): EnvStatus | null {
    if (id === LOCAL_ENV_ID) return { id, state: "local" };
    const status = this.getSsh(id)?.status();
    if (!status) return null;
    return { ...status, hostKey: this.environments.get(id)?.hostKey ?? null };
  }

  /** 环境被删除后释放连接。 */
  forget(id: string): void {
    this.ssh.get(id)?.env.close();
    this.ssh.delete(id);
  }

  close(): void {
    for (const { env } of this.ssh.values()) env.close();
    this.ssh.clear();
  }
}
