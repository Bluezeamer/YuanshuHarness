import { type FormEvent, useState } from "react";
import { Button, InlineNotice } from "../../../ui";
import { ArrowUpIcon } from "../../../ui/icons";
import { useChatSession } from "../hooks";
import { draftSink, pendingReason } from "../input/attachments";
import { RichInput } from "../input/RichInput";

// 执行体的输入栏：草稿与发送都走子会话自己的 useChatSession(execId)，不碰父会话。
export function ExecComposer({
  execId,
  name,
}: {
  execId: string;
  name: string;
}) {
  const { state, actions, draft } = useChatSession(execId);
  const [why, setWhy] = useState<string | null>(null);

  const pending = pendingReason(draft.attachments);

  const submit = () => {
    if (pending) return setWhy(pending);
    const r = actions.send();
    setWhy(r.ok ? null : r.message);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };
  return (
    <form
      className="ch-ex-composer"
      data-exec-form
      onSubmit={onSubmit}
      aria-label={`给 ${name} 补充要求`}
    >
      {(why || state.lastError) && (
        <InlineNotice tone="danger" className="ch-ex-err">
          {why ?? state.lastError?.message}
        </InlineNotice>
      )}
      <RichInput
        sessionId={execId}
        label={`给 ${name} 补充要求`}
        placeholder="给它补充要求…"
        rows={1}
        value={draft.text}
        onChange={(v) => {
          if (why) setWhy(null);
          actions.setDraft(v);
        }}
        sink={draftSink(draft.attachments, actions)}
        onSubmit={submit}
        end={
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<ArrowUpIcon />}
            aria-label="发送"
            title="发送"
            disabled={
              (draft.text.trim() === "" && draft.attachments.length === 0) ||
              pending !== null
            }
          />
        }
      />
    </form>
  );
}
