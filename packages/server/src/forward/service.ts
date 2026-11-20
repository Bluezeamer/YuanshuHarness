// 服务转发出口的监听管理：每条转发一个 http server，绑在 Server 所在机器的独立端口上。
// 端口分配要稳定（落库 + restore），因为用户会把地址收藏起来。
import httpMod from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { createSourceMatcher } from "../auth.js";
import { uuidv7 } from "../id.js";
import { HttpError } from "../lib/http-error.js";
import type { ForwardRow, ForwardStore } from "../store/forwards.js";
import type { ForwardHandler } from "./handler.js";

export interface ForwardView {
  id: string;
  envId: string;
  port: number;
  localPort: number;
  listening: boolean;
}

export interface ForwardServiceDeps {
  store: ForwardStore;
  handler: ForwardHandler;
  /** 转发端口的取值范围（含两端）；Server 自己的端口落在里面要跳过 */
  range: { from: number; to: number };
  /** 转发监听的地址，与 Server 一致 */
  host: string;
  /** 来源网段限制（与 Server 一致）；空表示不限制 */
  allowCidrs: string[];
  /** 这个工作区能不能转发这个环境上的这个端口（接线处用 workspaceReach 的 allowService） */
  allow(workspaceKey: string, envId: string, port: number): boolean;
  /** Server 自己的端口，转发端口分配要避开；还没监听时为 null */
  serverPort(): number | null;
}

export interface ForwardService {
  list(workspaceKey: string): ForwardView[];
  /** 幂等：同工作区同环境同端口已有转发就返回它（监听掉了就重新监听）；否则分配一个转发端口、开监听、落库。 */
  open(workspaceKey: string, envId: string, port: number): Promise<ForwardView>;
  /** 关监听（销毁已有连接）并删记录；不存在或不属于这个工作区返回 false。 */
  close(workspaceKey: string, id: string): Promise<boolean>;
  /** Server 启动后调用：给库里已有的转发重新开监听，端口被占的保留记录、listening=false。 */
  restore(): Promise<void>;
  stop(): Promise<void>;
}

interface Live {
  server: httpMod.Server;
  sockets: Set<Duplex>;
}

export function createForwardService(deps: ForwardServiceDeps): ForwardService {
  const live = new Map<string, Live>();
  // open 串行：并发打开同一目标（双击）时，后来的要看到先到的已落库的记录，不然会各占一个端口再撞唯一键
  let opening: Promise<unknown> = Promise.resolve();
  const inSource =
    deps.allowCidrs.length > 0 ? createSourceMatcher(deps.allowCidrs) : null;
  const inRange = (port: number) =>
    port >= deps.range.from && port <= deps.range.to;

  const view = (row: ForwardRow): ForwardView => ({
    id: row.id,
    envId: row.envId,
    port: row.port,
    localPort: row.localPort,
    listening: live.has(row.id),
  });

  /** 在 row.localPort 上起监听；端口被占返回 null，由调用方决定跳过还是保留记录。 */
  async function start(id: string, row: ForwardRow): Promise<Live | null> {
    const target = { envId: row.envId, port: row.port };
    const server = httpMod.createServer((req, res) => {
      try {
        deps.handler.request(req, res, target);
      } catch {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      }
    });
    server.on("upgrade", (req, socket, head) => {
      try {
        deps.handler.upgrade(req, socket, head, target);
      } catch {
        socket.destroy();
      }
    });
    const entry: Live = { server, sockets: new Set() };
    server.on("connection", (socket: net.Socket) => {
      // 来源网段不符的连接不给任何回应，直接断开（与 Server 的 allowCidrs 同一套判定）
      if (inSource && !inSource(socket.remoteAddress)) {
        socket.destroy();
        return;
      }
      entry.sockets.add(socket);
      socket.on("close", () => entry.sockets.delete(socket));
    });
    return await new Promise<Live | null>((done) => {
      const onError = () => done(null);
      server.once("error", onError);
      server.listen(row.localPort, deps.host, () => {
        server.off("error", onError);
        // 监听后的运行期错误不该把整个 Server 带下去
        server.on("error", () => {});
        live.set(id, entry);
        done(entry);
      });
    });
  }

  async function shutdown(id: string): Promise<void> {
    const entry = live.get(id);
    if (!entry) return;
    live.delete(id);
    for (const socket of entry.sockets) socket.destroy();
    entry.sockets.clear();
    await new Promise<void>((done) => entry.server.close(() => done()));
  }

  async function openOne(
    workspaceKey: string,
    envId: string,
    port: number,
  ): Promise<ForwardView> {
    // 转发端口本身不能再被转发：否则两跳之后自己转给自己
    if (inRange(port) || !deps.allow(workspaceKey, envId, port))
      throw new HttpError(
        "forbidden_target",
        "这个工作区够不到这个环境或端口",
        403,
      );

    const existing = deps.store.find(workspaceKey, envId, port);
    if (existing) {
      if (!live.has(existing.id)) await start(existing.id, existing);
      return view(existing);
    }

    // 从 from 起找最小的、不在库里、不是 Server 端口、且真的能 listen 的端口
    const used = new Set(deps.store.all().map((row) => row.localPort));
    const serverPort = deps.serverPort();
    const id = uuidv7();
    for (
      let localPort = deps.range.from;
      localPort <= deps.range.to;
      localPort++
    ) {
      if (used.has(localPort) || localPort === serverPort) continue;
      const row: ForwardRow = {
        id,
        workspaceKey,
        envId,
        port,
        localPort,
        createdAt: new Date().toISOString(),
      };
      if ((await start(id, row)) === null) continue;
      deps.store.insert(row);
      return view(row);
    }
    throw new HttpError(
      "range_exhausted",
      `转发端口用完了（${deps.range.from}-${deps.range.to}），先关掉不用的转发`,
      409,
    );
  }

  return {
    list(workspaceKey) {
      return deps.store.list(workspaceKey).map(view);
    },

    open(workspaceKey, envId, port) {
      const run = opening.then(() => openOne(workspaceKey, envId, port));
      opening = run.catch(() => {});
      return run;
    },

    async close(workspaceKey, id) {
      const row = deps.store.get(id);
      if (!row || row.workspaceKey !== workspaceKey) return false;
      await shutdown(id);
      deps.store.delete(id);
      return true;
    },

    async restore() {
      for (const row of deps.store.all()) {
        if (!live.has(row.id)) await start(row.id, row);
      }
    },

    async stop() {
      for (const id of [...live.keys()]) await shutdown(id);
    },
  };
}
