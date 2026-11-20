import { type ReactNode, useState } from "react";
import { Button, Dot } from "../../../ui";
import {
  attachmentPaths,
  pendingReason,
  useLocalAttachments,
} from "../input/attachments";
import { RichInput } from "../input/RichInput";
import type { AnswerBody, Prompt } from "../model/conversation";
import type { PromptEntry } from "./flowLog";

export type Answer = AnswerBody;

export interface CardProps {
  /** 回答里的附件要上传到这个会话的附件区 */
  sessionId: string;
  entry: PromptEntry;
  /** 弹窗答复失败的原因（已被其他端答复……） */
  error: string | null;
  onAnswer(prompt: Prompt, answer: Answer, label: string): void;
  /** 同时有几个待答弹窗时，卡头右侧的切换器（PromptPager 给） */
  pager?: ReactNode;
}

const DECISION: Record<string, string> = { allow: "批准", deny: "拒绝" };

const labelOf = (p: Prompt, optionId: string | undefined): string =>
  optionId === undefined
    ? ""
    : (DECISION[optionId] ??
      p.options.find((o) => o.id === optionId)?.label ??
      optionId);

// 回答之后收成一行：状态点 + 结论 + 说的是哪件事 + 用户补的话 + 时间
function Settled({
  tone,
  verdict,
  subject,
  note,
  time,
  state,
  label,
}: {
  tone: "live" | "danger" | "idle";
  verdict: string;
  subject: string;
  note?: string;
  time?: string;
  state: string;
  label: string;
}) {
  return (
    <section className="ch-settled" data-state={state} aria-label={label}>
      <Dot size="sm" tone={tone} />
      <span className="t-aux">{verdict}</span>
      <span className="ch-arg t-code">{subject}</span>
      {note && <span className="t-aux">{note}</span>}
      {time && <span className="t-mono">{time}</span>}
    </section>
  );
}

// 审批卡：琥珀描边加点，不铺底；批准是全局唯一的墨色实心按钮，拒绝与其余选项依次弱化。
// 拒绝可以说明理由（「拒绝并说明」展开一行输入，理由会转给 agent）；批准不带话。
export function ApprovalCard({
  sessionId,
  entry,
  error,
  onAnswer,
  pager,
}: CardProps) {
  const { prompt: p, answer, status } = entry;
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState("");
  const decision = answer?.optionId;
  const subject = p.detail?.summary ?? p.title;
  if (status === "answered")
    return (
      <Settled
        label="审批"
        state={decision === "deny" ? "denied" : "approved"}
        tone={decision === "deny" ? "danger" : "live"}
        verdict={
          decision === "deny"
            ? "已拒绝 · "
            : decision === "remember"
              ? "已批准并记住 · "
              : "已批准 · "
        }
        subject={subject}
        {...(answer?.text ? { note: `理由：${answer.text}` } : {})}
        {...(entry.time ? { time: entry.time } : {})}
      />
    );
  if (status === "gone")
    return (
      <Settled
        label="审批"
        state="gone"
        tone="idle"
        verdict="已由其他端答复，或已超时 / 被撤销 · "
        subject={subject}
      />
    );
  const submitted = answer !== undefined;
  const why = p.body && p.body !== p.detail?.summary ? p.body : null;
  // 批准在前（唯一的实心按钮），拒绝其次，其余选项（如「批准并记住」）最弱
  const rank = (id: string) => (id === "allow" ? 0 : id === "deny" ? 1 : 2);
  const options = [...p.options].sort((a, b) => rank(a.id) - rank(b.id));
  const deny = () => {
    const t = reason.trim();
    onAnswer(
      p,
      { optionId: "deny", ...(t ? { text: t } : {}) },
      labelOf(p, "deny"),
    );
  };
  return (
    <section className="ch-approve" data-state="pending" aria-label="审批">
      <div className="ch-approve-h">
        <Dot size="sm" tone="warn" />
        <span className="t-entry">需要你确认 · {p.title}</span>
        {pager}
      </div>
      {p.detail && <pre className="ch-out t-code">{p.detail.summary}</pre>}
      {why && <p className="ch-why t-aux">{why}</p>}
      <div className="ch-approve-f">
        {options.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant={
              o.id === "allow"
                ? "primary"
                : o.id === "deny"
                  ? "outline"
                  : "ghost"
            }
            disabled={submitted}
            onClick={() => onAnswer(p, { optionId: o.id }, labelOf(p, o.id))}
          >
            {DECISION[o.id] ?? o.label}
          </Button>
        ))}
        {p.input && !explaining && (
          <Button
            size="sm"
            variant="ghost"
            disabled={submitted}
            onClick={() => setExplaining(true)}
          >
            拒绝并说明
          </Button>
        )}
        <span className="ch-approve-n t-aux">
          {submitted ? "已提交，等待服务端确认…" : "其他已连接的端会同步收起"}
        </span>
      </div>
      {p.input && explaining && (
        <RichInput
          sessionId={sessionId}
          label="拒绝的理由"
          placeholder="告诉 agent 为什么拒绝，它会照着调整（可不写）"
          autoFocus
          value={reason}
          onChange={setReason}
          disabled={submitted}
          onSubmit={deny}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setExplaining(false);
          }}
          end={
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={submitted}
                onClick={() => setExplaining(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={submitted}
                onClick={deny}
              >
                拒绝
              </Button>
            </>
          }
        />
      )}
      {error && (
        <p className="ch-err t-aux" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// 提问卡：选项（可选，快捷回复）+ 输入框（有 input 就一直在，可带附件）；答后收成一行。
// 点选项即回答；输入框里已写的文字与附件会随选项一起发出（选了这项并补一句话）；也可以只提交文字。
export function QuestionCard({
  sessionId,
  entry,
  error,
  onAnswer,
  pager,
}: CardProps) {
  const { prompt: p, answer, status } = entry;
  const [text, setText] = useState("");
  const files = useLocalAttachments();
  const [why, setWhy] = useState<string | null>(null);
  if (status === "answered")
    return (
      <Settled
        label="提问"
        state="answered"
        tone="live"
        verdict="已答复 · "
        subject={answer?.label ?? ""}
        {...(entry.time ? { time: entry.time } : {})}
      />
    );
  if (status === "gone")
    return (
      <Settled
        label="提问"
        state="gone"
        tone="idle"
        verdict="已由其他端答复，或已超时 / 被撤销 · "
        subject={p.title}
      />
    );
  const submitted = answer !== undefined;
  const t = text.trim();
  const rich = p.input === "rich";
  const empty = t === "" && files.list.length === 0;
  const send = (optionId?: string) => {
    const blocked = pendingReason(files.list);
    if (blocked) return setWhy(blocked);
    if (optionId === undefined && empty) return;
    const names = files.list.map((a) => a.name);
    // 提交后收成一行的那句话：选项、文字，加上附了哪些文件
    const label = [
      p.options.find((o) => o.id === optionId)?.label,
      t,
      ...(names.length ? [`附件 ${names.join("、")}`] : []),
    ]
      .filter(Boolean)
      .join(" · ");
    onAnswer(
      p,
      {
        ...(optionId === undefined ? {} : { optionId }),
        ...(t ? { text: t } : {}),
        ...(files.list.length
          ? { attachments: attachmentPaths(files.list) }
          : {}),
      },
      label,
    );
  };
  return (
    <section className="ch-approve" data-state="pending" aria-label="提问">
      <div className="ch-approve-h">
        <Dot size="sm" tone="warn" />
        <span className="t-entry">等待你{p.input ? "回答" : "选择"}</span>
        {pager}
      </div>
      <p className="t-plain">{p.title}</p>
      {p.body && <p className="ch-why t-aux">{p.body}</p>}
      {p.options.length > 0 && (
        <div className="ch-approve-f">
          {p.options.map((o) => (
            <Button
              key={o.id}
              size="sm"
              variant="outline"
              disabled={submitted}
              onClick={() => send(o.id)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
      {p.input && (
        <RichInput
          sessionId={sessionId}
          label="回答"
          value={text}
          onChange={(v) => {
            setText(v);
            setWhy(null);
          }}
          {...(rich ? { sink: files } : {})}
          disabled={submitted}
          onSubmit={() => send()}
          end={
            <Button
              size="sm"
              variant="outline"
              disabled={submitted || empty}
              onClick={() => send()}
            >
              提交
            </Button>
          }
        />
      )}
      <p className="ch-approve-n t-aux">
        {submitted
          ? "已提交，等待服务端确认…"
          : p.options.length > 0 && p.input
            ? "选项可以直接点；写了内容再点选项，会一起发给 agent"
            : "在任一端回答后，其余端同步收起"}
      </p>
      {(why ?? error) && (
        <p className="ch-err t-aux" role="alert">
          {why ?? error}
        </p>
      )}
    </section>
  );
}

export function PromptCard(props: CardProps) {
  return props.entry.prompt.source === "approval" ? (
    <ApprovalCard {...props} />
  ) : (
    <QuestionCard {...props} />
  );
}
