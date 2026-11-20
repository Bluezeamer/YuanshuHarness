import { useState } from "react";
import type { ConnectionView } from "../../../api/connections";
import { Button, InlineNotice, Input } from "../../../ui";
import { ActivationSteps, HostKeyPrompt } from "./Activation";

function PasswordPrompt({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="st-rc-pw"
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== "") onSubmit(value);
      }}
    >
      <p className="t-aux">
        这条连接还没有可用的凭据。输入密码后保存到服务端（加密存放，不再回显），并立即激活。
      </p>
      <div className="st-rc-inline">
        <Input
          type="password"
          autoComplete="off"
          autoFocus
          aria-label="登录密码"
          placeholder="登录密码"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button
          type="submit"
          variant="outline"
          loading={busy}
          disabled={value === ""}
        >
          保存并激活
        </Button>
      </div>
    </form>
  );
}

export interface NoticesProps {
  c: ConnectionView;
  passwordOpen: boolean;
  activationHidden: boolean;
  hostKeyDismissed: boolean;
  busy: boolean;
  onSubmitPassword: (password: string) => void;
  onCancelPassword: () => void;
  onHideActivation: () => void;
  onCancelActivation: () => void;
  onTrust: () => void;
  onDismissHostKey: () => void;
}

// 头部与各设置块之间「有事才出现」的几条：改动待激活、密码输入、六步激活、主机密钥核对。平时整块不占位。
export function Notices(p: NoticesProps) {
  const { c } = p;
  const blocked =
    c.hostKeyChange !== null && c.activation?.failedStage === "hostkey";
  const showSteps =
    c.activation !== null &&
    !(c.activation.state === "done" && p.activationHidden);
  const pending = c.hostKeyChange !== null && c.status !== "active";
  if (!c.dirty && !p.passwordOpen && !showSteps && !pending) return null;

  return (
    <div className="st-rc-notes">
      {c.dirty && (
        <InlineNotice tone="warn" strong>
          地址、认证或策略已修改。改动在下一次激活时生效，当前会话仍使用旧配置。
        </InlineNotice>
      )}

      {p.passwordOpen && (
        <PasswordPrompt
          busy={p.busy}
          onSubmit={p.onSubmitPassword}
          onCancel={p.onCancelPassword}
        />
      )}

      {showSteps && c.activation && (
        <ActivationSteps
          activation={c.activation}
          blocked={blocked}
          onClose={p.onHideActivation}
          onCancel={p.onCancelActivation}
        />
      )}

      {c.hostKeyChange !== null &&
        c.status !== "active" &&
        (p.hostKeyDismissed ? (
          <InlineNotice tone="warn">
            主机密钥待核对。点击「激活」会重新展开核对，确认前不会发送凭据。
          </InlineNotice>
        ) : (
          <HostKeyPrompt
            change={c.hostKeyChange}
            busy={p.busy}
            onTrust={p.onTrust}
            onDismiss={p.onDismissHostKey}
          />
        ))}
    </div>
  );
}
