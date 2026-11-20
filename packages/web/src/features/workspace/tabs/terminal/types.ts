import type { Pane, Tab, TabAfx } from "../../model/types";

// 与 P2a 约定的标签渲染 props 同形状；这里自己声明，合并时由接线处对齐。
export interface TerminalTabProps {
  tab: Tab;
  pane: Pane;
  sessionId: string | null;
  active: boolean;
  patchTab(patch: Partial<Tab>): void;
  patchAfx(patch: Partial<TabAfx>): void;
  close(): void;
}

export interface TerminalTabExtra {
  /** 打开终端管理（Popover/Modal 由接线处决定放哪）；缺省时不显示入口。 */
  onManage?: () => void;
}

/** 连接控制器对外汇报的状态；界面只据此渲染。 */
export type LinkState =
  | { kind: "connecting"; stage: "creating" | "attaching" }
  | { kind: "live" }
  | { kind: "reconnecting"; attempt: number; max: number }
  /** 重连次数用尽：终端仍在服务端，只等用户手动重试，绝不新建 shell。 */
  | { kind: "lost"; attempts: number }
  /** gone：服务端已没有这个终端（重启或被关）；exit：shell 自己退出。 */
  | {
      kind: "ended";
      reason: "gone" | "exit";
      exitCode: number | null;
    }
  | {
      kind: "failed";
      cause: FailCause;
      max?: number | null;
      retryAfter?: number;
    };

export type FailCause =
  | "limit"
  | "throttled"
  | "invalid"
  | "not_found"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "server";

/** HostId → 服务端环境 id：'server' 即 daemon 所在机器（本地环境），其余主机 id 就是连接/环境 id。 */
export const environmentOf = (host: string | undefined): string =>
  !host || host === "server" ? "local" : host;

/** 终端 id 的末段：uuidv7 的随机部分在尾部，8 位足够区分。 */
export const shortId = (id: string): string => id.slice(-8);
