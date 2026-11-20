import { useEffect, useState } from "react";
import type { EditableContent } from "../../../api";
import { Button, InlineNotice } from "../../../ui";
import type { ChatSession } from "../hooks";
import {
  attachmentPaths,
  pendingReason,
  refToAttachment,
  useLocalAttachments,
} from "../input/attachments";
import { RichInput } from "../input/RichInput";
import { stripAttachLines } from "./format";

// 一条排队消息的编辑：文字与附件（可增删）；保存把两者一起交给服务端替换。
function QueueEdit({
  sessionId,
  index,
  content,
  onSave,
  onCancel,
}: {
  sessionId: string;
  index: number;
  content: EditableContent;
  onSave(text: string, attachments: { path: string }[]): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(content.text);
  const files = useLocalAttachments(content.attachments.map(refToAttachment));
  const [why, setWhy] = useState<string | null>(null);
  const empty = text.trim() === "" && files.list.length === 0;
  const save = () => {
    const blocked = pendingReason(files.list);
    if (blocked) return setWhy(blocked);
    if (!empty) onSave(text.trim(), attachmentPaths(files.list));
  };
  return (
    <div className="ch-q-edit">
      <RichInput
        sessionId={sessionId}
        label={`编辑第 ${index + 1} 条排队消息`}
        autoFocus
        value={text}
        onChange={(v) => {
          setText(v);
          setWhy(null);
        }}
        sink={files}
        onSubmit={save}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          onCancel();
        }}
        end={
          <>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button variant="outline" size="sm" disabled={empty} onClick={save}>
              保存
            </Button>
          </>
        }
      />
      {why && <InlineNotice tone="danger">{why}</InlineNotice>}
    </div>
  );
}

// 排队的消息：agent 执行中用户又发的话。它是「用户这一侧」的东西：靠右、虚线气泡、贴着输入卡，
// 不在对话流里，也不是可折叠的行，所以和模型的输出、工具调用分得开。
// 文本来自快照 / queue.updated；编辑与删除走服务端命令，重排结果同样由 queue.updated 广播回来。
export function QueueBar({
  sessionId,
  session,
}: {
  sessionId: string;
  session: ChatSession;
}) {
  const { state, actions } = session;
  const [editing, setEditing] = useState<{
    index: number;
    content: EditableContent;
  } | null>(null);
  // 显示文本被服务端截断过，编辑前先取一次全文；取回期间禁用编辑入口。
  const [loading, setLoading] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const queue = state.queue;

  // 队列变化（条目送达 / 被删）时：正在编辑的那条可能已经不存在，取全文失败的提示也作废。
  useEffect(() => {
    if (editing && editing.index >= queue.length) setEditing(null);
    setLoadError(null);
  }, [queue.length, editing]);

  if (queue.length === 0) return null;
  // 队列字符串里可能残留服务端注入的附件标记行，展示前剥掉。
  const preview = (text: string) =>
    stripAttachLines(text)
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() || "（附件消息）";

  const startEdit = async (index: number) => {
    setLoadError(null);
    setLoading(index);
    const full = await actions.queueTexts();
    setLoading(null);
    const content = full?.[index];
    if (!full || content === undefined) {
      // 取全文期间队列可能已经变化，按“重试”处理即可，等 queue.updated 刷新后再点。
      setLoadError("读取完整排队内容失败，请重试");
      return;
    }
    if (full.length !== queue.length) {
      setLoadError("排队消息已变化，请重试");
      return;
    }
    setEditing({ index, content });
  };

  const save = (text: string, attachments: { path: string }[]) => {
    if (editing && actions.editQueue(editing.index, text, attachments))
      setEditing(null);
  };
  const remove = (index: number) => {
    if (actions.removeQueue(index) && editing?.index === index)
      setEditing(null);
  };

  return (
    <section className="ch-queue" data-queue="" aria-label="排队消息">
      <span className="t-aux ch-queue-h">
        排队 {queue.length} 条 · 当前步骤结束后送达
      </span>
      {loadError && <InlineNotice tone="danger">{loadError}</InlineNotice>}
      {queue.map((text, index) =>
        editing?.index === index ? (
          <QueueEdit
            // biome-ignore lint/suspicious/noArrayIndexKey: 排队文本可重复，没有稳定 id
            key={index}
            sessionId={sessionId}
            index={index}
            content={editing.content}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 排队文本可重复，没有稳定 id
          <div key={index} className="ch-q" title={stripAttachLines(text)}>
            <span className="ch-q-t t-plain">{preview(text)}</span>
            <span className="ch-q-act u-reveal">
              <Button
                variant="ghost"
                size="sm"
                disabled={loading !== null}
                onClick={() => void startEdit(index)}
              >
                {loading === index ? "载入中…" : "编辑"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`删除第 ${index + 1} 条排队消息`}
                onClick={() => remove(index)}
              >
                删除
              </Button>
            </span>
          </div>
        ),
      )}
    </section>
  );
}
