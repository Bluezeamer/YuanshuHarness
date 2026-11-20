// agent 请你接管页面时，工具条上方的一行横幅：原因 + 「我已操作完成」「拒绝」（拒绝可以写理由）。
// 页面本来就是你在操作时，agent 是在请求使用它：文案换成「请求使用这个页面」「交给 agent」，答复的机制不变。
// 与聊天里的提问卡片先到先得，另一边由服务端撤销。
import { useState } from "react";
import type { HandoffReply } from "../../../../api/browser";
import { Button, InlineNotice, Input } from "../../../../ui";

export interface HandoffBannerProps {
  reason: string;
  /** 页面此刻是用户在操作：agent 是请求使用它，而不是请用户去操作 */
  userHasIt: boolean;
  /** 返回失败原因（中文）；成功返回 null，横幅随页面状态更新自行消失 */
  onAnswer(reply: HandoffReply): Promise<string | null>;
}

export function HandoffBanner({
  reason,
  userHasIt,
  onAnswer,
}: HandoffBannerProps) {
  const [refusing, setRefusing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (reply: HandoffReply) => {
    setBusy(true);
    setError(null);
    const failed = await onAnswer(reply);
    setBusy(false);
    if (failed) {
      // 失败原因只在主横幅上显示：拒绝输入行收回去，写好的理由还留着
      setError(failed);
      setRefusing(false);
    }
  };
  const refuse = () => answer({ outcome: "refused", reason: text.trim() });

  if (refusing)
    return (
      <div className="ws-wb-strip">
        <div className="ws-wb-refuse">
          <Input
            autoFocus
            value={text}
            placeholder={
              userHasIt
                ? "告诉 agent 为什么不给它用（可不写）"
                : "告诉 agent 为什么不接管（可不写）"
            }
            aria-label="拒绝的理由"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && refuse()}
          />
          <Button size="sm" loading={busy} onClick={refuse}>
            拒绝
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRefusing(false)}>
            取消
          </Button>
        </div>
      </div>
    );

  return (
    <div className="ws-wb-strip">
      <InlineNotice tone={error ? "danger" : "warn"}>
        {error ??
          (userHasIt
            ? `agent 请求使用这个页面：${reason}`
            : `agent 请你接管：${reason}`)}
      </InlineNotice>
      <div className="ws-wb-strip-actions">
        <Button
          size="sm"
          loading={busy}
          onClick={() => answer({ outcome: "done" })}
        >
          {userHasIt ? "交给 agent" : "我已操作完成"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRefusing(true)}>
          拒绝
        </Button>
      </div>
    </div>
  );
}
