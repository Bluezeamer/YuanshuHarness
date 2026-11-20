import type { ExecutionBody } from "../../../api/flows";
import {
  Button,
  Chip,
  Dot,
  HoverCard,
  InlineNotice,
  PeekCard,
  ReadBar,
} from "../../../ui";
import type { ChatSession } from "../hooks";
import { fmtTokens } from "../model/metrics";
import { execCtxText, execElapsed, execStatus } from "./execModel";

const DOT = {
  run: "live",
  idle: "idle",
  done: "accent",
  failed: "danger",
} as const;

// 头只有一行：状态点、名称（悬停看模型 / 工具 / 上下文）、角色、状态与已运行时长、上下文读条
export function ExecHeader({
  exec,
  now,
}: {
  exec: ExecutionBody;
  now: number;
}) {
  const st = execStatus(exec);
  const elapsed = execElapsed(exec, now);
  const win = exec.ctx.win ?? 0;
  const pct =
    win > 0 ? Math.min(100, Math.round((exec.ctx.used / win) * 100)) : null;
  const facts: Array<readonly [string, string]> = [
    ["角色", exec.role],
    ...(exec.model ? [["模型", exec.model] as const] : []),
    ["工具", `${exec.tools.length} 个`],
    ["上下文", win ? execCtxText(exec) : fmtTokens(exec.ctx.used)],
  ];
  return (
    <header className="ch-ex-head">
      <Dot
        tone={DOT[st.tone]}
        size="sm"
        {...(st.tone === "run" ? { motion: "pulse" as const } : {})}
      />
      <HoverCard card={<PeekCard title={exec.name} facts={facts} />}>
        <span className="ch-ex-nm t-entry" data-ex="name">
          {exec.name}
        </span>
      </HoverCard>
      <Chip data-ex="role">{exec.role}</Chip>
      <span className="ch-ex-gap" />
      <span className="ch-ex-st t-aux" data-ex="state" data-tone={st.tone}>
        {st.label}
        {elapsed ? ` ${elapsed}` : ""}
      </span>
      <ReadBar
        className="ch-ex-ctx"
        data-ex="ctx"
        label={`${exec.name} 的上下文占用`}
        value={exec.ctx.used}
        max={win}
        text={pct === null ? fmtTokens(exec.ctx.used) : `${pct}%`}
      />
    </header>
  );
}

// 子会话连接异常 / 断线：与主对话同一条横幅（样式复用 .ch-conn），点击重连恢复一份新快照。
export function ExecConn({ session }: { session: ChatSession }) {
  const { conn } = session.state;
  if (conn !== "reconnecting" && conn !== "closed") return null;
  return (
    <InlineNotice
      tone={conn === "closed" ? "danger" : "warn"}
      className="ch-conn"
      data-conn={conn}
      data-ex="conn"
    >
      <span>
        {conn === "closed"
          ? "连接已断开，点击「重新连接」后以新快照恢复"
          : "正在重连…"}
      </span>
      {conn === "closed" && (
        <Button size="sm" onClick={session.actions.reconnect}>
          重新连接
        </Button>
      )}
    </InlineNotice>
  );
}
