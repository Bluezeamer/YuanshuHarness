import {
  activateConnection,
  type ConnectionList,
  type ConnectionView,
  type Credential,
  createConnection,
  createCredential,
  type Deactivated,
  deactivateConnection,
  deleteConnection,
  deleteCredential,
  getConnection,
  listConnections,
  listCredentials,
  type ServerHost,
  trustHostKey,
  type UpdateConnectionInput,
  updateConnection,
} from "../../../api/connections";
import { type DirectoryInfo, listDirectories } from "../../../api/directories";
import { loadToken } from "../../../api/http";
import { listSessions, type SessionInfo } from "../../../api/sessions";
import { type ActionError, describeError } from "./errors";
import { activatingOf, type NewForm } from "./model";

type Failed = { ok: false } & ActionError;
export type Outcome<T> = { ok: true; data: T } | Failed;

export interface RemoteData {
  server: ServerHost;
  conns: ConnectionView[];
  creds: Credential[];
  directories: DirectoryInfo[];
  sessions: SessionInfo[];
}

export type RemoteState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | ({
      phase: "ready";
      /** 已发出激活请求、服务端状态还没跟上的连接。 */
      starting: string | null;
    } & RemoteData);

export interface StoreDeps {
  token?: () => string | null;
  /** 激活进度的轮询间隔。 */
  pollMs?: number;
  /** 已激活连接的状态巡检间隔（发现掉线）。 */
  watchMs?: number;
}

const BUSY: Failed = {
  ok: false,
  code: "busy",
  status: 0,
  message: "同一时间只能激活一个连接，等当前这个结束后再试。",
};

const fail = (e: unknown): Failed => ({ ok: false, ...describeError(e) });

/** 某条连接上挂载的目录与其中的会话。 */
export function mountsOf(
  s: Pick<RemoteData, "directories" | "sessions">,
  connectionId: string,
) {
  const ws = s.directories.filter((w) => w.environmentId === connectionId);
  const ids = new Set(ws.map((w) => w.id));
  return {
    directories: ws,
    sessions: s.sessions.filter((x) => x.directoryId && ids.has(x.directoryId))
      .length,
  };
}

/**
 * 远程连接页的外部 store（配合 useSyncExternalStore）。
 * 激活是长过程：POST 之后轮询 GET /connections/:id，直到 activation 不再是 running。
 * 配置类写操作串行，激活/断开/信任不进队列（它们本身就是用户等待的动作）。
 */
export function createRemoteStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  const pollMs = deps.pollMs ?? 400;
  const watchMs = deps.watchMs ?? 5000;
  let state: RemoteState = { phase: "loading" };
  const subs = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let alive = true;
  let watcher: ReturnType<typeof setInterval> | undefined;
  let watching = false;
  const following = new Set<string>();

  const set = (next: RemoteState) => {
    state = next;
    for (const f of subs) f();
  };
  const patch = (p: Partial<RemoteData> & { starting?: string | null }) => {
    if (state.phase === "ready") set({ ...state, ...p });
  };
  const conns = () => (state.phase === "ready" ? state.conns : []);
  const creds = () => (state.phase === "ready" ? state.creds : []);
  const put = (v: ConnectionView) =>
    patch({ conns: conns().map((c) => (c.id === v.id ? v : c)) });

  // 连接换了认证方式后，原来为它建的密码凭据就没人用了（密码页签里看不到、也删不掉）：一并清掉。
  // 仍被别处引用时服务端会拒，忽略即可。
  const dropPassword = async (
    prev: ConnectionView | undefined,
    nextSecretId: string | null,
  ) => {
    const old = prev?.auth;
    if (
      old?.kind === "password" &&
      old.secretId &&
      old.secretId !== nextSecretId
    )
      await deleteCredential(token(), old.secretId).catch(() => {});
  };

  const write = <T>(job: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    const run = queue.then(job);
    queue = run;
    return run;
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // 静默刷新两类列表；失败时保留旧数据。
  const reloadConns = async () => {
    try {
      patch({ conns: (await listConnections(token())).connections });
    } catch {}
  };
  const reloadCreds = async () => {
    try {
      patch({ creds: await listCredentials(token()) });
    } catch {}
  };

  /** 轮询到激活结束；返回最后一次看到的视图，网络/404 中断时返回 null。 */
  async function follow(id: string): Promise<ConnectionView | null> {
    if (following.has(id)) return null;
    following.add(id);
    try {
      let last = conns().find((c) => c.id === id) ?? null;
      while (
        alive &&
        last &&
        (last.activation?.state === "running" || last.status === "activating")
      ) {
        await sleep(pollMs);
        if (!alive) break;
        last = await getConnection(token(), id);
        put(last);
      }
      return last;
    } catch {
      return null;
    } finally {
      following.delete(id);
    }
  }

  const running = (exceptId?: string) => {
    if (state.phase !== "ready") return false;
    const id = state.starting ?? activatingOf(state.conns)?.id ?? null;
    return id !== null && id !== exceptId;
  };

  // 已激活的连接随时可能被对端或网络断开，服务端状态变了页面也要跟上。
  // 页面可见且有已激活连接时才取列表；激活进行中另有 follow 在盯，这里让开。
  async function watch(): Promise<void> {
    if (watching || state.phase !== "ready") return;
    if (document.visibilityState === "hidden" || running()) return;
    if (!state.conns.some((c) => c.status === "active")) return;
    watching = true;
    const seen = state;
    try {
      const list = await listConnections(token());
      // 请求期间别的操作改过状态，这份结果可能已过时，留给下一轮
      if (alive && state === seen) patch({ conns: list.connections });
    } catch {
    } finally {
      watching = false;
    }
  }

  async function activate(id: string): Promise<Outcome<ConnectionView>> {
    if (running()) return BUSY;
    patch({ starting: id });
    try {
      put(await activateConnection(token(), id));
      const final = await follow(id);
      if (!final) {
        // 轮询中断：以服务端当前状态为准
        const cur = await getConnection(token(), id);
        put(cur);
        return { ok: true, data: cur };
      }
      return { ok: true, data: final };
    } catch (e) {
      // 409（待核对 / 跳板未激活 / 已激活）：拿最新视图让界面显示对应状态
      await getConnection(token(), id).then(put, () => {});
      // 别处（另一个标签页）正在激活：以服务端为准，整页重取并接上那次激活
      if (describeError(e).code === "busy") void store.load();
      return fail(e);
    } finally {
      patch({ starting: null });
    }
  }

  const store = {
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    getSnapshot: (): RemoteState => state,

    /** 挂载时调用：加载并接上服务端已在进行的激活。 */
    start() {
      alive = true;
      clearInterval(watcher);
      watcher = setInterval(() => void watch(), watchMs);
      return store.load();
    },
    /** 卸载时调用：停掉轮询。 */
    stop() {
      alive = false;
      clearInterval(watcher);
    },

    /** 首次加载显示 loading；已有数据时静默刷新。 */
    async load(): Promise<void> {
      if (state.phase !== "ready") set({ phase: "loading" });
      try {
        const [list, keys, ws, ss] = await Promise.all([
          listConnections(token()) as Promise<ConnectionList>,
          listCredentials(token()),
          listDirectories(token()),
          listSessions(token()),
        ]);
        set({
          phase: "ready",
          starting: state.phase === "ready" ? state.starting : null,
          server: list.server,
          conns: list.connections,
          creds: keys,
          directories: ws.ok ? ws.data : [],
          sessions: ss.ok ? ss.data : [],
        });
        for (const c of list.connections)
          if (c.status === "activating") void follow(c.id);
      } catch (e) {
        if (state.phase !== "ready")
          set({ phase: "error", message: describeError(e).message });
      }
    },

    activate,

    /** 核对通过：信任新指纹，并自动继续被阻断的激活（B8）。 */
    async trustAndActivate(id: string): Promise<Outcome<ConnectionView>> {
      if (running()) return BUSY;
      try {
        put(await trustHostKey(token(), id));
      } catch (e) {
        return fail(e);
      }
      return activate(id);
    },

    async deactivate(id: string): Promise<Outcome<Deactivated>> {
      try {
        const r = await deactivateConnection(token(), id);
        put(r.connection);
        // 下游被连带暂停，状态以服务端为准
        await reloadConns();
        return { ok: true, data: r };
      } catch (e) {
        return fail(e);
      }
    },

    /**
     * 改连接登记。带 password 时先为它建一条密码凭据、把认证改指向它，再和其余改动一并提交；
     * 改指向没成功（如激活中被锁定）时，刚建的密码不留成孤儿。
     */
    update(
      id: string,
      input: UpdateConnectionInput,
      password?: string,
    ): Promise<Outcome<ConnectionView>> {
      return write(async () => {
        const prev = conns().find((c) => c.id === id);
        let created: string | null = null;
        try {
          let body = input;
          if (password !== undefined) {
            if (!prev) return fail(null);
            created = await newPasswordSecret(prev.label, password);
            body = { ...input, auth: { secretId: created, kind: "password" } };
          }
          const v = await updateConnection(token(), id, body);
          put(v);
          created = null;
          if (body.auth) {
            await dropPassword(prev, v.auth.secretId);
            await reloadCreds();
          }
          return { ok: true, data: v };
        } catch (e) {
          if (created) void deleteCredential(token(), created).catch(() => {});
          return fail(e);
        }
      });
    },

    /** 为连接换一个密码凭据（新建一条密码并改指向）；密码不回显。 */
    setPassword(
      id: string,
      password: string,
    ): Promise<Outcome<ConnectionView>> {
      return store.update(id, {}, password);
    },

    create(form: NewForm): Promise<Outcome<ConnectionView>> {
      return write(async () => {
        const label = form.label.trim();
        let created: string | null = null;
        try {
          let secretId = form.keyId;
          if (form.authKind === "password") {
            secretId = await newPasswordSecret(label, form.password);
            created = secretId;
          }
          const v = await createConnection(token(), {
            label,
            host: form.host.trim(),
            port: Number(form.port),
            user: form.user.trim(),
            auth: {
              secretId,
              kind: form.authKind === "key" ? "key" : "password",
            },
            jump: form.jumpId ? [form.jumpId] : [],
          });
          patch({ conns: [...conns(), v] });
          void reloadCreds();
          // 新连接可能被当作跳板，上游的 dependants 也变了
          if (form.jumpId) void reloadConns();
          return { ok: true, data: v };
        } catch (e) {
          if (created) void deleteCredential(token(), created).catch(() => {});
          return fail(e);
        }
      });
    },

    remove(id: string): Promise<Outcome<null>> {
      return write(async () => {
        const cur = conns().find((c) => c.id === id);
        try {
          await deleteConnection(token(), id);
          patch({ conns: conns().filter((c) => c.id !== id) });
          // 密码是为这条连接建的，一并清掉（仍被引用时服务端会拒，忽略即可）
          if (cur?.auth.kind === "password" && cur.auth.secretId)
            await deleteCredential(token(), cur.auth.secretId).catch(() => {});
          await reloadCreds();
          await reloadConns();
          return { ok: true, data: null };
        } catch (e) {
          return fail(e);
        }
      });
    },

    addKey(name: string, pem: string): Promise<Outcome<null>> {
      return write(async () => {
        try {
          await createCredential(token(), {
            name,
            kind: "ssh_key",
            value: pem,
          });
          await reloadCreds();
          return { ok: true, data: null };
        } catch (e) {
          return fail(e);
        }
      });
    },

    removeKey(id: string): Promise<Outcome<null>> {
      return write(async () => {
        try {
          await deleteCredential(token(), id);
          patch({ creds: creds().filter((k) => k.id !== id) });
          return { ok: true, data: null };
        } catch (e) {
          return fail(e);
        }
      });
    },
  };

  // 密码类凭据的名字在库里唯一：撞名时加序号。
  async function newPasswordSecret(label: string, value: string) {
    for (let n = 1; ; n++) {
      const name = n === 1 ? `${label} 密码` : `${label} 密码 ${n}`;
      try {
        return (
          await createCredential(token(), { name, kind: "password", value })
        ).id;
      } catch (e) {
        if (describeError(e).code !== "name_exists" || n >= 6) throw e;
      }
    }
  }

  return store;
}

export type RemoteStore = ReturnType<typeof createRemoteStore>;
