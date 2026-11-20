import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  LoginOptions,
} from "@earendil-works/pi-ai";
import { uuidv7 } from "../id.js";

/** pi 的 ModelRuntime 结构上满足它：订阅登录只需要这两个入口。 */
export interface LoginRuntime {
  login(
    providerId: string,
    type: "oauth",
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<unknown>;
  logout(providerId: string): Promise<void>;
}

export interface LoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface LoginState {
  loginId: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** 最近一次 auth_url 事件 */
  link: { url: string; instructions?: string } | null;
  /** 最近一次 device_code 事件 */
  device: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  } | null;
  /** 最近一条 info / progress 文本 */
  message: string | null;
  /** 正在等用户输入的那个提示；没有为 null */
  prompt: LoginPrompt | null;
  error: string | null;
}

const TTL_MS = 10 * 60_000;
const RETAIN_MS = 5 * 60_000;

export interface LoginManagerOpts {
  /** 登录整体超时；到点取消并记 failed。 */
  ttlMs?: number;
  /** 登录成功（拿回凭据）时回调；路由层用它把认证方式改成 oauth。 */
  onDone?: (providerId: string) => void;
}

interface Pending {
  promptId: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

interface Session {
  providerId: string;
  state: LoginState;
  controller: AbortController;
  pending: Pending | null;
  ttl: NodeJS.Timeout;
  reap: NodeJS.Timeout | null;
}

const timer = (fn: () => void, ms: number): NodeJS.Timeout => {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
};

const promptOf = (id: string, p: AuthPrompt): LoginPrompt => ({
  id,
  type: p.type,
  message: p.message,
  ...("placeholder" in p && p.placeholder
    ? { placeholder: p.placeholder }
    : {}),
  ...(p.type === "select" ? { options: [...p.options] } : {}),
});

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** 订阅登录的会话管理：后台跑 pi 的 login，把事件与提示摊平成可轮询的状态。 */
export class LoginManager {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly onDone?: (providerId: string) => void;

  constructor(
    private readonly runtime: LoginRuntime,
    opts: LoginManagerOpts = {},
  ) {
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.onDone = opts.onDone;
  }

  start(providerId: string): LoginState {
    // 同一供应商只留一个进行中的登录：旧的先取消（它的会话仍留在表里供前端读结果）。
    for (const s of [...this.sessions.values()])
      if (s.providerId === providerId && s.state.status === "running") {
        this.settle(s, "cancelled");
        this.retire(s);
        s.controller.abort();
      }

    const loginId = uuidv7();
    const controller = new AbortController();
    const session: Session = {
      providerId,
      state: {
        loginId,
        status: "running",
        link: null,
        device: null,
        message: null,
        prompt: null,
        error: null,
      },
      controller,
      pending: null,
      ttl: timer(() => {
        if (this.settle(session, "failed", "登录超时")) {
          this.retire(session);
          session.controller.abort();
        }
      }, this.ttlMs),
      reap: null,
    };
    this.sessions.set(loginId, session);

    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (p) => this.prompt(session, p),
      notify: (ev) => this.notify(session, ev),
    };
    void this.runtime.login(providerId, "oauth", interaction).then(
      () => {
        if (this.settle(session, "done")) this.onDone?.(providerId);
        this.retire(session);
      },
      (err: unknown) => {
        if (this.settle(session, "failed", messageOf(err)))
          this.retire(session);
      },
    );
    return snapshot(session.state);
  }

  get(providerId: string, loginId: string): LoginState | null {
    const s = this.sessions.get(loginId);
    return s && s.providerId === providerId ? snapshot(s.state) : null;
  }

  answer(
    providerId: string,
    loginId: string,
    promptId: string,
    value: string,
  ): boolean {
    const s = this.sessions.get(loginId);
    if (!s || s.providerId !== providerId || s.state.status !== "running")
      return false;
    const p = s.pending;
    if (!p || p.promptId !== promptId) return false;
    s.pending = null;
    s.state.prompt = null;
    p.resolve(value);
    return true;
  }

  cancel(providerId: string, loginId: string): boolean {
    const s = this.sessions.get(loginId);
    if (!s || s.providerId !== providerId) return false;
    if (this.settle(s, "cancelled")) {
      this.retire(s);
      s.controller.abort();
    }
    return true;
  }

  logout(providerId: string): Promise<void> {
    return this.runtime.logout(providerId);
  }

  /** 服务停止：撤掉所有定时器并中止进行中的登录。 */
  dispose(): void {
    for (const s of this.sessions.values()) {
      this.settle(s, "cancelled");
      clearTimeout(s.ttl);
      if (s.reap) clearTimeout(s.reap);
      s.controller.abort();
    }
    this.sessions.clear();
  }

  private prompt(session: Session, p: AuthPrompt): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (session.state.status !== "running")
        return reject(new Error("登录已结束"));
      const promptId = uuidv7();
      session.state.prompt = promptOf(promptId, p);
      session.pending = { promptId, resolve, reject };
      // 流程自己有了结果（如回调服务器先收到码）会中止这个提示：挂起的等待要跟着结束。
      p.signal?.addEventListener(
        "abort",
        () => {
          if (session.pending?.promptId !== promptId) return;
          session.pending = null;
          session.state.prompt = null;
          reject(new Error("提示已失效"));
        },
        { once: true },
      );
    });
  }

  private notify(session: Session, ev: AuthEvent): void {
    if (session.state.status !== "running") return;
    const s = session.state;
    if (ev.type === "auth_url")
      s.link = {
        url: ev.url,
        ...(ev.instructions ? { instructions: ev.instructions } : {}),
      };
    else if (ev.type === "device_code")
      s.device = {
        userCode: ev.userCode,
        verificationUri: ev.verificationUri,
        ...(ev.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: ev.expiresInSeconds }),
      };
    else s.message = ev.message;
  }

  private retire(session: Session): void {
    clearTimeout(session.ttl);
    // 结束后留一会儿，让前端最后一次轮询能读到结果。
    session.reap ??= timer(() => {
      this.sessions.delete(session.state.loginId);
    }, RETAIN_MS);
  }

  /** 只在还在跑的时候落定状态；返回是否真的改了。 */
  private settle(
    session: Session,
    status: LoginState["status"],
    error: string | null = null,
  ): boolean {
    if (session.state.status !== "running") return false;
    session.state.status = status;
    session.state.error = error;
    session.state.prompt = null;
    const p = session.pending;
    session.pending = null;
    if (p) p.reject(new Error(error ?? "登录已结束"));
    return true;
  }
}

const snapshot = (s: LoginState): LoginState => ({
  ...s,
  link: s.link ? { ...s.link } : null,
  device: s.device ? { ...s.device } : null,
  prompt: s.prompt
    ? {
        ...s.prompt,
        ...(s.prompt.options
          ? { options: s.prompt.options.map((o) => ({ ...o })) }
          : {}),
      }
    : null,
});
