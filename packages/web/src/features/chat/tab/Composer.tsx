import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { reloadSession } from "../../../api/flows";
import { loadToken } from "../../../api/http";
import { Button, Chip, IconButton, InlineNotice, toast } from "../../../ui";
import { ArrowUpIcon, CloseIcon, StopIcon } from "../../../ui/icons";
import type { ChatSession } from "../hooks";
import { AttachmentBar } from "../input/AttachmentBar";
import { draftSink, pendingReason } from "../input/attachments";
import { useFilePicker } from "../input/useFilePicker";
import type { AttachmentUploads } from "../input/useUploads";
import { parseInput } from "../model/commands";
import { useEnterSends } from "./context";
import { type InsertApi, SlashMenu } from "./InsertMenus";
import { McpDialog } from "./McpDialog";
import { Toolbar } from "./Toolbar";
import { useChatConfig } from "./useChatConfig";
import { useSlashMenu } from "./useSlashMenu";

const MAX_H = 132;
const MIN_H = 36;

export interface ComposerProps {
  sessionId: string;
  session: ChatSession;
  agentName: string;
  /** 附件上传链路；由 ChatView 持有，整个对话标签的拖入与输入卡共用 */
  uploads: AttachmentUploads;
  onSent(): void;
}

// 输入卡：引用 chip / 附件卡片（有内容才显示）→ textarea → 工具行与发送。
// 附件先上传到会话附件区，发送时只带引用；上传中或有失败项时禁止发送。
// 文件拖入由 ChatView 接管（整个对话标签可落），这里只处理选择文件与粘贴。
export function Composer({
  sessionId,
  session,
  agentName,
  uploads,
  onSent,
}: ComposerProps) {
  const { state, actions, draft } = session;
  const cfg = useChatConfig(sessionId);
  const enterSends = useEnterSends();
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useFilePicker(uploads);
  const caret = useRef<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const compacting = state.compacting;
  const empty = draft.text.trim() === "" && draft.attachments.length === 0;
  const sink = draftSink(draft.attachments, actions);
  const pending = pendingReason(draft.attachments);

  // 自适应高度；插入文本后把光标放回指定位置。
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft.text 变化即重新量高度并落光标
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    // 量高度要先缩回一行：锁住输入卡的高度，免得对话流被临时撑高、贴底的位置被浏览器夹小
    const card = form.current;
    if (card) card.style.height = `${card.offsetHeight}px`;
    el.style.height = "auto";
    if (el.scrollHeight > 0)
      el.style.height = `${Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight))}px`;
    if (card) card.style.height = "";
    if (caret.current !== null) {
      el.focus();
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [draft.text]);

  const reload = async () => {
    const r = await reloadSession(loadToken(), sessionId);
    if (r.ok) {
      toast("已重载 MCP 与主机环境，用 /mcp 看各服务的连接状态");
      cfg.refetchContext();
    } else
      toast(
        r.kind === "conflict"
          ? "会话正在运行，等这一轮结束再重载"
          : "重载失败，请稍后再试",
        { tone: "danger" },
      );
  };

  const submit = () => {
    // 附件没就绪时不发：给出原因（上传中 / 有失败项），与发送按钮的禁用保持一致。
    if (pending) {
      setSendError(pending);
      return;
    }
    if (empty) return;
    // /mcp 与 /reload 是界面自己的动作：不发给会话，不进历史
    const cmd = parseInput(draft.text);
    if (cmd.kind === "mcp" || cmd.kind === "reload") {
      actions.setDraft("");
      if (cmd.kind === "mcp") setMcpOpen(true);
      else void reload();
      return;
    }
    const sent = draft.attachments;
    const r = actions.send();
    setSendError(r.ok ? null : r.message);
    if (r.ok) onSent();
    // 发出后草稿清空：回收图片的本地预览 URL。
    if (r.ok)
      for (const a of sent) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const insert: InsertApi = {
    at(text, back = 0) {
      const el = ta.current;
      const t = draft.text;
      const a = el?.selectionStart ?? t.length;
      const b = el?.selectionEnd ?? t.length;
      caret.current = a + text.length - back;
      actions.setDraft(t.slice(0, a) + text + t.slice(b));
    },
    command(name) {
      const head = `/${name} `;
      const old = /^\/\S*\s?/.exec(draft.text);
      caret.current = head.length;
      actions.setDraft(
        head + (old ? draft.text.slice(old[0].length) : draft.text),
      );
    },
    pickFile: picker.pick,
  };

  const slash = useSlashMenu({
    cfg,
    insert,
    text: draft.text,
    setText: actions.setDraft,
  });

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(e)) return;
    if (
      enterSends &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      submit();
    }
  };

  // 附件就绪后清掉「还在上传 / 上传失败」的提示，不让它残留在输入卡上方。
  useEffect(() => {
    if (!pending) setSendError(null);
  }, [pending]);

  const err = sendError ?? state.lastError?.message ?? null;
  return (
    <form
      ref={form}
      className="ch-composer"
      data-composer=""
      autoComplete="off"
      onSubmit={onSubmit}
    >
      {err && (
        <InlineNotice tone="danger" className="ch-notice">
          <span>{err}</span>
          <IconButton
            size="sm"
            label="关闭提示"
            icon={<CloseIcon />}
            onClick={() => {
              setSendError(null);
              actions.dismissError();
            }}
          />
        </InlineNotice>
      )}
      {state.compactError && !compacting && (
        <InlineNotice tone="danger" className="ch-notice">
          压缩失败：{state.compactError}
        </InlineNotice>
      )}
      {compacting && (
        <InlineNotice className="ch-notice">
          正在压缩上下文…期间发送的消息会先排队，压缩完成后送出
        </InlineNotice>
      )}
      {draft.quotes.length > 0 && (
        <ul className="ch-chiprow" aria-label="引用">
          {draft.quotes.map((c) => (
            <li key={c.id} className="ch-qchip" title={c.quote.text}>
              <Chip className="t-mono">{c.quote.label}</Chip>
              <IconButton
                size="sm"
                label={`移除引用 ${c.quote.label}`}
                icon={<CloseIcon />}
                onClick={() => actions.removeQuote(c.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="ch-box" ref={box}>
        <AttachmentBar sessionId={sessionId} sink={sink} uploads={uploads} />
        <textarea
          ref={ta}
          className="ch-ta t-read"
          rows={1}
          aria-label={`给 ${agentName} 发消息`}
          placeholder={
            enterSends
              ? "输入消息，/ 调出命令，Enter 发送"
              : "输入消息，/ 调出命令"
          }
          value={draft.text}
          onChange={(e) => {
            const next = e.target.value;
            setSendError(null);
            actions.setDraft(next);
            slash.onChange(next);
          }}
          onKeyDown={onKey}
          onPaste={picker.onPaste}
        />
        <Toolbar
          cfg={cfg}
          insert={insert}
          end={
            <>
              {state.running && (
                <Button
                  variant="primary"
                  size="sm"
                  aria-label="停止运行"
                  icon={<StopIcon />}
                  disabled={state.stopPending}
                  onClick={actions.stop}
                />
              )}
              <Button
                type="submit"
                variant="outline"
                size="sm"
                aria-label="发送"
                icon={<ArrowUpIcon />}
                title={pending ?? undefined}
                disabled={empty || pending !== null}
              />
            </>
          }
        />
      </div>
      <SlashMenu
        options={slash.options}
        open={slash.open}
        active={slash.active}
        anchorRef={box}
        onClose={() => slash.close(false)}
        onPick={slash.pick}
      />
      <McpDialog
        sessionId={sessionId}
        open={mcpOpen}
        onClose={() => {
          setMcpOpen(false);
          cfg.refetchContext();
        }}
      />
      {picker.input}
    </form>
  );
}
