// 关闭终端标签 = 杀服务端终端（已定决策）。这里负责「关之前问一下」和「真正杀」。
// 调用方式（TabBar / 关闭窗格 / 关闭会话）：
//   const { confirmClose, dialog } = useTerminalCloseGuard();
//   ... if (!(await confirmClose([tab]))) return;  // 传入要被移除的全部标签，非终端标签自动忽略
//   dispatch(closeTab(...));
//   return <>{...}{dialog}</>;   // dialog 必须渲染在调用方的树里
import { type ReactNode, useCallback, useRef, useState } from "react";
import { loadToken } from "../../../../api/http";
import { closeTerminal, getTerminal } from "../../../../api/terminals";
import { Button, Modal, toast } from "../../../../ui";
import type { Tab } from "../../model/types";
import { shortId } from "./types";

/** 需要用户确认的终端：前台有进程，或（ssh）无法判断。 */
export interface RiskyTerminal {
  termId: string;
  cwd: string | undefined;
  /** false = 明确有前台进程；null = 无法判断。 */
  busy: true | null;
}

export type CloseAsk = (risky: RiskyTerminal[]) => Promise<boolean>;

/**
 * 关闭一批标签里的终端：先探测，有风险的统一确认一次，确认后逐个关闭。
 * 返回 true 表示这些标签可以从布局里移除；false 表示用户取消或有终端没关掉（标签应保留，免得留下孤儿）。
 */
export async function closeTerminalTabs(
  tabs: readonly Tab[],
  ask: CloseAsk,
): Promise<boolean> {
  const live = tabs.filter(
    (t) => t.type === "term" && t.termId && !t.termEnded,
  );
  if (live.length === 0) return true;
  const token = loadToken();

  // 探测：404 说明已经没了，不需要关也不需要问。
  const probed = await Promise.all(
    live.map(async (t) => {
      const id = t.termId as string;
      const r = await getTerminal(token, id);
      if (!r.ok && r.kind === "not_found") return null;
      // 拿不到状态（网络/服务端错误）时按「无法判断」处理，交给关闭请求去定成败
      const busy = r.ok ? r.data.busy : null;
      return { tab: t, id, busy };
    }),
  );
  const present = probed.filter((p) => p !== null);

  const risky: RiskyTerminal[] = present
    .filter((p) => p.busy !== false)
    .map((p) => ({
      termId: p.id,
      cwd: p.tab.cwd,
      busy: p.busy === true ? true : null,
    }));
  if (risky.length > 0 && !(await ask(risky))) return false;

  const results = await Promise.all(
    present.map(async (p) => {
      const r = await closeTerminal(token, p.id);
      return r.ok || r.kind === "not_found";
    }),
  );
  if (results.every(Boolean)) return true;
  toast("终端没有关掉，标签已保留，请重试", { tone: "danger" });
  return false;
}

interface Pending {
  risky: RiskyTerminal[];
  settle: (ok: boolean) => void;
}

export function useTerminalCloseGuard(): {
  confirmClose: (tabs: readonly Tab[]) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  // 同时只会有一个确认框；新的关闭请求到来时旧的按取消处理。
  const current = useRef<Pending | null>(null);

  const ask = useCallback<CloseAsk>(
    (risky) =>
      new Promise<boolean>((resolve) => {
        current.current?.settle(false);
        const p: Pending = {
          risky,
          settle: (ok) => {
            if (current.current === p) {
              current.current = null;
              setPending(null);
            }
            resolve(ok);
          },
        };
        current.current = p;
        setPending(p);
      }),
    [],
  );

  const confirmClose = useCallback(
    (tabs: readonly Tab[]) => closeTerminalTabs(tabs, ask),
    [ask],
  );

  const risky = pending?.risky ?? [];
  const unknownOnly = risky.length > 0 && risky.every((r) => r.busy === null);
  const dialog = (
    <Modal
      open={pending !== null}
      onClose={() => pending?.settle(false)}
      title={risky.length > 1 ? `关闭 ${risky.length} 个终端？` : "关闭终端？"}
      description={
        unknownOnly
          ? "无法确认这些终端里是否还有进程在运行。"
          : "这些终端的前台还有进程在运行，关闭会直接结束它们。"
      }
      size="sm"
      dismissOnScrim={false}
      footer={
        <>
          <Button size="sm" onClick={() => pending?.settle(false)}>
            取消
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => pending?.settle(true)}
          >
            关闭终端
          </Button>
        </>
      }
    >
      <ul className="ws-term-close-list t-mono">
        {risky.map((r) => (
          <li key={r.termId}>
            #{shortId(r.termId)}
            {r.cwd ? ` · ${r.cwd}` : ""}
            {r.busy === null ? "（无法判断）" : ""}
          </li>
        ))}
      </ul>
    </Modal>
  );
  return { confirmClose, dialog };
}
