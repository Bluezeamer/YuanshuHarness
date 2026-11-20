// 「环境信息」内置段：会话创建时间 + 每台涉及主机的系统事实与可用状态。
// 我们生成（英文）、用户不可改，不做成卡片。它是状态映射里的一个槽：主机接入 / 移除 / 被用户断开，
// 这一段的文本就变了，下一次运行前的比较会发现并用状态通知（文本差异）告诉模型，不用重建会话。
import os from "node:os";

export const ENVIRONMENT_TAG = "environment";
// pi 无条件产出的裸路径段：我们用主目录的引用覆盖它（见 pool 的 withEnvironment）。
export const CWD_TAG = "cwd";

export interface EnvironmentHost {
  /** 主机名：就是地址 `<host>:<path>` 里的前缀（session/address.ts 的 hostLabel） */
  name: string;
  /** 系统事实，如 "Linux 6.5.0-27-generic, x86_64"；还没探测到是 null */
  facts: string | null;
  /** 用户主动「断开」了这台主机：工具会一直失败，直到用户重新激活 */
  disconnected: boolean;
  /** 这台主机上登记的目录；不标当前目录，免得每次切换目录都改这段文本 */
  directories: { ref: string; path: string }[];
}

export interface EnvironmentInput {
  /** 会话创建时间（ISO）；取不到就不写时间行，不拿当前时间顶替（会随每次渲染变） */
  startedAt: string | null;
  hosts: readonly EnvironmentHost[];
  /** 时区偏移（分钟，东为正）；缺省取本机时区 */
  offsetMinutes?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 「2026-11-08 09:12 (UTC+08:00)」；时间无效返回 null。 */
export function formatStarted(
  iso: string,
  offsetMinutes?: number,
): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const off = offsetMinutes ?? -d.getTimezoneOffset();
  const t = new Date(d.getTime() + off * 60_000);
  const a = Math.abs(off);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} (UTC${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)})`;
}

/** 本机的系统事实，格式与 ssh 探测（uname -sr; uname -m）对齐。 */
export function localFacts(): string {
  const arch = os.arch() === "x64" ? "x86_64" : os.arch();
  return `${os.type()} ${os.release()}, ${arch}`;
}

/** ssh 激活时探测到的一行（各行用「 · 」连着）转成与本机一致的写法。 */
export const probeFacts = (probe: string): string =>
  probe.replace(/\s*·\s*/g, ", ");

const DISCONNECTED =
  "DISCONNECTED by the user. Tools on this host fail until the user activates it again (Settings → Remote connections). Ask the user to do that; do not retry meanwhile.";

/**
 * <cwd> 段的正文：只说起点，不随切换变（切换由尾部通知负责）。根会话从主目录出发；
 * 子代理只在一个目录里工作（不能切换），写它自己的那个，而不是父会话的主目录。
 */
export const cwdSection = (
  start: { ref: string; path: string },
  o: { sub?: boolean } = {},
): string =>
  o.sub
    ? `The session works in the directory ${start.ref} (${start.path}). It cannot switch directories; relative paths and bash use it.`
    : `The session starts in its main directory ${start.ref} (${start.path}). The current directory starts there; relative paths and bash use the current directory.`;

export function environmentSection(i: EnvironmentInput): string | null {
  if (i.hosts.length === 0) return null;
  const started = i.startedAt
    ? formatStarted(i.startedAt, i.offsetMinutes)
    : null;
  const lines: string[] = [];
  if (started)
    lines.push(
      `Session started: ${started}. This is the real date when this session began. It may be well after your training data ends, so do not infer the current year from memory. Time has passed since then; run \`date\` if you need the current time.`,
      "",
    );
  lines.push(
    "Hosts in this session, with their directories. A directory is written <host>:<name>; relative paths and bash use the current directory, and the host parameter of a tool can name any host or directory:",
  );
  for (const h of i.hosts) {
    lines.push(
      `- "${h.name}": ${h.facts ?? "system not detected yet"}${h.disconnected ? ` — ${DISCONNECTED}` : ""}`,
    );
    for (const d of h.directories) lines.push(`  - ${d.ref}  ${d.path}`);
  }
  return lines.join("\n");
}
