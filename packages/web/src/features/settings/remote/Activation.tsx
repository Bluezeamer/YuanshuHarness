import {
  ACTIVATION_STEPS,
  type Activation,
  type ActivationStep,
  type ActivationStepId,
  type HostKeyChange,
} from "../../../api/connections";
import { Button, Dot, InlineNotice } from "../../../ui";
import { activationText } from "./errors";

const STEP_TONE = {
  pending: { tone: "idle" },
  running: { tone: "accent", motion: "pulse" },
  done: { tone: "live" },
  failed: { tone: "danger" },
} as const;

const STATE_TEXT = {
  pending: "未开始",
  running: "进行中",
  done: "完成",
  failed: "失败",
} as const;

// 服务端在开始前就返回六步；万一返回得不全，按固定顺序补齐，界面永远是六段。
const fullSteps = (a: Activation): ActivationStep[] =>
  ACTIVATION_STEPS.map(
    ({ id, name }) =>
      a.steps.find((s) => s.id === id) ?? { id, name, state: "pending" },
  );

const stageName = (id: ActivationStepId | undefined): string =>
  ACTIVATION_STEPS.find((s) => s.id === id)?.name ?? "";

/** 六段可观察步骤。耗时列固定宽度，毫秒定格后不挤动细节。 */
export function ActivationSteps({
  activation: a,
  blocked = false,
  onClose,
  onCancel,
}: {
  activation: Activation;
  /** 失败是主机密钥待核对造成的：不是出错，是等用户确认。 */
  blocked?: boolean;
  /** 完成后「收起」。 */
  onClose?: () => void;
  /** 进行中「取消」：服务端的断开会中止正在进行的激活。 */
  onCancel?: () => void;
}) {
  const steps = fullSteps(a);
  const total = steps.reduce((n, s) => n + (s.ms ?? 0), 0);
  const summary =
    a.state === "done"
      ? `激活完成 · ${total}ms`
      : blocked
        ? "等待你核对主机密钥"
        : a.state === "failed"
          ? `停在「${stageName(a.failedStage)}」`
          : "正在建立连接…";
  return (
    <div className="st-rc-steps" data-state={blocked ? "blocked" : a.state}>
      <ol aria-label="激活步骤">
        {steps.map((s) => (
          <li key={s.id} className="st-rc-step t-aux" data-state={s.state}>
            <Dot
              {...(blocked && s.state === "failed"
                ? { tone: "warn" as const }
                : STEP_TONE[s.state])}
            />
            <span className="st-rc-step-t">
              {s.name}
              <span className="sr-only">（{STATE_TEXT[s.state]}）</span>
              {s.detail && <span className="t-mono">{s.detail}</span>}
            </span>
            <span className="st-rc-step-ms t-mono">
              {s.ms !== undefined && s.state !== "pending" ? `${s.ms}ms` : ""}
            </span>
          </li>
        ))}
      </ol>
      {a.state === "failed" && !blocked && (
        <InlineNotice tone="danger" className="st-rc-fail">
          <span className="st-rc-fail-main">
            <span className="t-entry">{stageName(a.failedStage)}失败</span>
            {a.code && <span className="t-mono">{a.code}</span>}
            <span>{a.code ? activationText(a.code) : a.message}</span>
          </span>
          {a.message && a.code && (
            <p className="t-mono st-rc-fail-raw">{a.message}</p>
          )}
        </InlineNotice>
      )}
      <div className="st-rc-actfoot">
        <span className="st-rc-hint t-aux" role="status">
          {summary}
        </span>
        {a.state === "running" && onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
        )}
        {a.state === "done" && onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            收起
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 主机密钥的阻断式核对：首次连接只展示本次指纹；变更时并排「记录 / 本次」。
 * 确认前不发凭据；变更永不自动信任，必须点按钮。
 */
export function HostKeyPrompt({
  change,
  busy,
  onTrust,
  onDismiss,
}: {
  change: HostKeyChange;
  busy: boolean;
  onTrust: () => void;
  onDismiss: () => void;
}) {
  const first = change.old === null;
  return (
    <section className="st-rc-hk" aria-label="主机密钥核对">
      <div className="st-rc-hk-h">
        <Dot tone="warn" />
        <span className="t-entry">
          {first ? "首次连接 · 尚未记录主机密钥" : "主机密钥已变更"}
        </span>
      </div>
      <p className="t-aux">
        {first
          ? "确认这个指纹属于目标主机。信任后写入 known_hosts；之后再变更会阻断连接。确认前不会发送任何凭据。"
          : "记录中的指纹与本次不一致。可能是主机重装，也可能是中间人。核对前不会发送任何凭据。"}
      </p>
      <dl className="st-rc-fps">
        {!first && (
          <div className="st-rc-fprow">
            <dt className="t-aux">记录</dt>
            <dd className="t-mono">{change.old}</dd>
            <dd className="t-aux">{change.oldType}</dd>
          </div>
        )}
        <div className="st-rc-fprow">
          <dt className="t-aux">本次</dt>
          <dd className="t-mono">{change.new}</dd>
          <dd className="t-aux">{change.newType}</dd>
        </div>
      </dl>
      <div className="st-rc-hk-a">
        <span className="t-aux st-rc-hk-tip">
          在主机上运行{" "}
          <span className="t-mono">
            ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
          </span>{" "}
          核对。
        </span>
        <Button variant="ghost" onClick={onDismiss}>
          暂不处理
        </Button>
        <Button variant="outline" loading={busy} onClick={onTrust}>
          {first ? "信任并继续" : "信任新密钥并继续"}
        </Button>
      </div>
    </section>
  );
}
