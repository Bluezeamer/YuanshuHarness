// 终端不可用时盖在最近输出上的说明层：已结束 / 连接用尽 / 创建失败。
// 三种都给出下一步动作，且都不会自行新建 shell。
import { Button, Dot } from "../../../../ui";
import type { Tab } from "../../model/types";
import type { FailCause, LinkState } from "./types";
import { shortId } from "./types";

export interface StatePanelProps {
  state: LinkState;
  tab: Tab;
  /** 已结束态的「重新打开」：显式新建终端。 */
  onReopen(): void;
  /** lost / failed 态的「重试」。 */
  onRetry(): void;
  onManage?: (() => void) | undefined;
}

const FAIL_TITLE: Record<FailCause, string> = {
  limit: "终端数量已达上限",
  throttled: "请求过于频繁",
  invalid: "无法按该目录创建终端",
  not_found: "环境或工作目录不存在",
  network: "网络不通，无法创建终端",
  unauthorized: "令牌已失效",
  forbidden: "当前来源不被允许",
  server: "Server 无法启动终端",
};

function failHint(s: Extract<LinkState, { kind: "failed" }>): string {
  switch (s.cause) {
    case "limit":
      return s.max
        ? `服务端当前已有 ${s.max} 个终端。到终端管理里关掉不用的，再回来重试。`
        : "到终端管理里关掉不用的终端，再回来重试。";
    case "throttled":
      return s.retryAfter ? `请 ${s.retryAfter} 秒后重试。` : "请稍后重试。";
    case "unauthorized":
      return "刷新页面后重新输入令牌。";
    case "server":
      return "pty 不可用或环境连接失败，详见 Server 日志。";
    default:
      return "";
  }
}

function Card({
  tone,
  title,
  desc,
  meta,
  children,
}: {
  tone?: "warn" | "danger";
  title: string;
  desc?: string;
  meta?: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="ws-term-veil">
      <div className="ws-term-card" data-tone={tone} role="status">
        <div className="ws-term-card-title t-entry">
          {tone && <Dot tone={tone} size="sm" />}
          {title}
        </div>
        {desc && <div className="ws-term-card-desc t-aux">{desc}</div>}
        {meta && meta.length > 0 && (
          <div className="ws-term-card-meta t-mono">
            {meta.map((m) => (
              <span key={m} title={m}>
                {m}
              </span>
            ))}
          </div>
        )}
        <div className="ws-term-card-actions">{children}</div>
      </div>
    </div>
  );
}

export function StatePanel({
  state,
  tab,
  onReopen,
  onRetry,
  onManage,
}: StatePanelProps) {
  const manage = onManage && (
    <Button size="sm" onClick={onManage}>
      终端管理
    </Button>
  );

  if (state.kind === "ended") {
    const meta = [
      tab.termId ? `终端 #${shortId(tab.termId)}` : "",
      tab.cwd ? `目录 ${tab.cwd}` : "",
    ].filter(Boolean);
    return (
      <Card
        tone="warn"
        title="终端已结束"
        desc={
          state.reason === "exit"
            ? `Shell 已退出${state.exitCode === null ? "" : `（退出码 ${state.exitCode}）`}。`
            : "服务端重启或终端已被关闭，其中的进程已不存在。上方保留了最近的输出。"
        }
        meta={meta}
      >
        <Button variant="primary" size="sm" onClick={onReopen}>
          重新打开
        </Button>
        {manage}
      </Card>
    );
  }

  if (state.kind === "lost")
    return (
      <Card
        tone="danger"
        title="连接已断开"
        desc={`已重连 ${state.attempts} 次仍未成功。终端还在服务端，不会新建 shell，点重试接回。`}
      >
        <Button variant="primary" size="sm" onClick={onRetry}>
          重试
        </Button>
        {manage}
      </Card>
    );

  if (state.kind === "failed")
    return (
      <Card
        tone={state.cause === "limit" ? "warn" : "danger"}
        title={
          state.cause === "limit" && state.max
            ? `终端数量已达上限（${state.max}）`
            : FAIL_TITLE[state.cause]
        }
        desc={failHint(state)}
      >
        {state.cause !== "unauthorized" && (
          <Button variant="primary" size="sm" onClick={onRetry}>
            重试
          </Button>
        )}
        {state.cause === "limit" && manage}
      </Card>
    );

  return null;
}
