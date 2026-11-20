import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type ConnectStage, SshConnectError } from "../ssh/connection.js";
import { displayFingerprint } from "../ssh/fingerprint.js";
import type { AuditLog } from "../store/audit.js";
import type {
  ConnectionRecord,
  ConnectionStore,
} from "../store/connections.js";
import type { SecretStore } from "../store/secrets.js";
import type { EnvHub } from "./hub.js";

// 激活六步（与 remote-connections.html 的 STEP_DEF 一致）。id 是线上取值，name 只用于展示。
export const ACTIVATION_STEPS = [
  { id: "resolve", name: "解析主机" },
  { id: "tcp", name: "TCP 连接" },
  { id: "hostkey", name: "主机密钥" },
  { id: "auth", name: "认证" },
  { id: "probe", name: "远端探测" },
  { id: "channel", name: "控制通道" },
] as const;

export type ActivationStepId = (typeof ACTIVATION_STEPS)[number]["id"];

// SshConnection.connect 内部的三个阶段对应其中的第 2~4 步。
const STAGE_STEP: Record<ConnectStage, number> = {
  tcp: 1,
  hostkey: 2,
  auth: 3,
};

export type ConnectionStatus =
  | "active"
  | "inactive"
  | "verify-required"
  | "activating";

export interface ActivationStep {
  id: ActivationStepId;
  name: string;
  state: "pending" | "running" | "done" | "failed";
  ms?: number;
  detail?: string;
}

export interface Activation {
  state: "running" | "done" | "failed";
  steps: ActivationStep[];
  /** 失败时所在的步骤 id。 */
  failedStage?: ActivationStepId;
  code?: string;
  message?: string;
}

export type StartResult =
  | { ok: true; activation: Activation }
  | {
      ok: false;
      error:
        | "not_found"
        | "activating"
        | "busy"
        | "already_active"
        | "verify_required"
        | "jump_inactive";
      /** jump_inactive 时未激活的跳板。 */
      jump?: { id: string; label: string };
      /** busy 时正在激活的另一条连接。 */
      activating?: { id: string; label: string };
    };

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// 激活状态机：把连接的建立拆成可轮询的六步。进度只在内存里，最近一次的结果保留到再次激活或断开。
export class Activator {
  private readonly runs = new Map<string, Activation>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    private readonly connections: ConnectionStore,
    private readonly hub: EnvHub,
    private readonly secrets: SecretStore,
    private readonly audit?: AuditLog,
  ) {}

  /** 仍应展示的最近一次激活过程；成功后连接掉线则不再展示。 */
  activation(id: string): Activation | null {
    const run = this.runs.get(id);
    if (!run) return null;
    return run.state === "done" && !this.hub.isConnected(id) ? null : run;
  }

  status(id: string): ConnectionStatus {
    if (this.aborts.has(id)) return "activating";
    if (this.connections.get(id)?.hostKeyPending) return "verify-required";
    return this.hub.isConnected(id) ? "active" : "inactive";
  }

  start(id: string): StartResult {
    const rec = this.connections.get(id);
    if (!rec) return { ok: false, error: "not_found" };
    if (this.aborts.has(id)) return { ok: false, error: "activating" };
    if (this.hub.isConnected(id)) return { ok: false, error: "already_active" };
    // 同时只允许一个连接处于激活过程中（docs/model/remote-connection.md §2）：以服务端为准，多标签页也一样
    const [other] = this.aborts.keys();
    if (other !== undefined)
      return {
        ok: false,
        error: "busy",
        activating: {
          id: other,
          label: this.connections.get(other)?.label ?? other,
        },
      };
    // 指纹待核对时不再发凭据，必须先 trust
    if (rec.hostKeyPending !== null)
      return { ok: false, error: "verify_required" };
    const jump = rec.jumpId ? this.connections.get(rec.jumpId) : null;
    if (jump && !this.hub.isConnected(jump.id))
      return {
        ok: false,
        error: "jump_inactive",
        jump: { id: jump.id, label: jump.label },
      };

    const run: Activation = {
      state: "running",
      steps: ACTIVATION_STEPS.map(({ id, name }) => ({
        id,
        name,
        state: "pending",
      })),
    };
    this.runs.set(id, run);
    const ac = new AbortController();
    this.aborts.set(id, ac);
    // 让登记信息的改动在本次激活生效，并解除之前的断开暂停
    this.hub.prepareActivation(id);
    void this.run(rec, jump, run, ac);
    return { ok: true, activation: run };
  }

  /** 断开并递归暂停所有下游；返回被断开的连接（自己在最前）。 */
  deactivate(id: string): ConnectionRecord[] | null {
    const rec = this.connections.get(id);
    if (!rec) return null;
    const downstream = this.connections.descendants(id);
    // 正在激活就是「取消」：由 run() 记「已取消激活」，这里不再记一条「已断开」
    const cancelling = this.aborts.has(id);
    // 先断下游再断自己，避免下游在跳板消失时报一堆连带错误
    for (const r of [...downstream].reverse().concat(rec)) {
      this.aborts.get(r.id)?.abort();
      // 立刻释放：被取消的激活还要收尾一小会儿，期间不能再算「正在激活」
      this.aborts.delete(r.id);
      this.runs.delete(r.id);
      this.hub.pause(r.id);
    }
    const all = [rec, ...downstream];
    if (!cancelling)
      this.audit?.record({
        actor: "user",
        kind: "env",
        environmentId: id,
        summary: `已断开${downstream.length ? `（连带 ${downstream.length} 个下游）` : ""}`,
        detail: {
          op: "deactivate",
          result: "ok",
          cascade: downstream.map((d) => d.id),
        },
      });
    return all;
  }

  /** 连接被删除后丢掉进度。 */
  forget(id: string): void {
    this.aborts.get(id)?.abort();
    this.runs.delete(id);
  }

  private async run(
    rec: ConnectionRecord,
    jump: ConnectionRecord | null | undefined,
    run: Activation,
    ac: AbortController,
  ): Promise<void> {
    const t0 = Date.now();
    const id = rec.id;
    let at = Date.now();
    const begin = (i: number) => {
      at = Date.now();
      const s = run.steps[i];
      if (s) s.state = "running";
    };
    const finish = (i: number, detail?: string) => {
      const s = run.steps[i];
      if (!s) return;
      s.state = "done";
      s.ms = Date.now() - at;
      if (detail !== undefined) s.detail = detail;
    };
    // 阶段回调只推进「当前步」；ssh 连接内部自己依次触发 tcp → hostkey → auth
    const first = rec.hostKey === null;
    let current = 0;
    const secretKind = rec.secretId
      ? this.secrets.get(rec.secretId)?.kind
      : null;
    try {
      begin(0);
      if (rec.secretId !== null && !secretKind)
        throw new StepError("secret_missing", "环境引用的密码不存在");
      if (!jump && !isIP(rec.host))
        await lookup(rec.host).catch((err: unknown) => {
          throw new StepError("dns_failed", errMsg(err));
        });
      finish(0, jump ? `经 ${jump.label}` : "直连");

      const env = this.hub.getSsh(id);
      if (!env) throw new StepError("not_found", "连接已被删除");
      current = 1;
      begin(1);
      await env.connect({
        signal: ac.signal,
        onStage: (stage) => {
          if (stage === "tcp") {
            finish(
              1,
              `${rec.host}:${rec.port} · ${jump ? "经跳板通道" : "TCP 握手"}`,
            );
            current = 2;
            begin(2);
          } else if (stage === "hostkey") {
            this.connections.clearPending(id);
            const key = this.connections.get(id)?.hostKey;
            const type = key ? displayFingerprint(key).keyType : "";
            finish(
              2,
              `${type} · ${first ? "首次记录，自动信任" : "与记录一致"}`,
            );
            current = 3;
            begin(3);
          } else {
            finish(3, secretKind === "ssh_key" ? "publickey" : "password");
            current = 4;
            begin(4);
          }
        },
      });
      const probe = await env.probe().catch((err: unknown) => {
        throw new StepError("probe_failed", errMsg(err));
      });
      this.hub.setFacts(id, probe);
      finish(4, probe);
      current = 5;
      begin(5);
      const home = await env.homedir().catch((err: unknown) => {
        throw new StepError("channel_failed", errMsg(err));
      });
      finish(5, `复用通道就绪 · ${home}`);
      // 最后一步完成的同时被取消：不能再当成功
      ac.signal.throwIfAborted();
      this.hub.pin(id);
      this.connections.touchActive(id, new Date().toISOString());
      run.state = "done";
      this.audit?.record({
        actor: "user",
        kind: "env",
        environmentId: id,
        summary: "激活成功",
        detail: { op: "activate", result: "ok", durationMs: Date.now() - t0 },
      });
    } catch (err) {
      if (ac.signal.aborted) this.cancelled(rec, current, Date.now() - t0);
      else this.fail(rec, run, current, err, Date.now() - t0);
    } finally {
      // 取消时 deactivate 已先释放；不能误删取消之后新开的那次激活
      if (this.aborts.get(id) === ac) this.aborts.delete(id);
    }
  }

  // 用户取消（断开会中止进行中的激活）：不是失败。连接已由 deactivate 关掉，进度也已丢弃。
  private cancelled(
    rec: ConnectionRecord,
    current: number,
    durationMs: number,
  ): void {
    const stage = ACTIVATION_STEPS[current];
    this.audit?.record({
      actor: "user",
      kind: "env",
      environmentId: rec.id,
      summary: "已取消激活",
      detail: {
        op: "cancel",
        result: "cancelled",
        stage: stage?.id,
        durationMs,
        info: `停在「${stage?.name ?? ""}」`,
      },
    });
  }

  private fail(
    rec: ConnectionRecord,
    run: Activation,
    current: number,
    err: unknown,
    durationMs: number,
  ): void {
    let step = current;
    let code = "error";
    if (err instanceof SshConnectError) {
      step = STAGE_STEP[err.stage];
      code = err.code;
    } else if (err instanceof StepError) code = err.code;
    const s = run.steps[step];
    if (s) {
      s.state = "failed";
      s.ms = s.ms ?? 0;
    }
    run.state = "failed";
    const failed = ACTIVATION_STEPS[step];
    run.failedStage = failed?.id;
    run.code = code;
    run.message = errMsg(err);
    // 探测/通道失败时连接已建好，断掉；暂停状态不动，留给用户决定
    this.hub.getSsh(rec.id)?.close();
    const blocked = err instanceof SshConnectError && err.seen !== null;
    const seen = blocked
      ? displayFingerprint(err.seen as string).fingerprint
      : "";
    const known =
      blocked && err.known ? displayFingerprint(err.known).fingerprint : null;
    this.audit?.record({
      actor: "user",
      kind: "env",
      environmentId: rec.id,
      summary: blocked
        ? known
          ? "主机密钥变更，激活被阻断"
          : "首次连接，主机密钥待核对"
        : `激活失败：${failed?.name ?? ""}（${code}）`,
      detail: {
        op: blocked ? "hostkey" : "activate",
        result: "error",
        stage: run.failedStage,
        code,
        durationMs,
        info: blocked ? (known ? `${seen} ≠ ${known}` : seen) : run.message,
      },
    });
  }
}

// 第一步（解析主机）与探测/通道步骤里的受控失败，带给界面的错误码。
class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
