import { useEffect, useRef, useState } from "react";
import { loadToken } from "../../../api/http";
import {
  answerLogin,
  cancelLogin,
  getLogin,
  type LoginPrompt,
  type LoginState,
  startLogin,
} from "../../../api/providers";
import { Button, copyText, InlineNotice, Input, Modal } from "../../../ui";
import { SpinnerIcon } from "../../../ui/icons";
import { describeError } from "./errors";

const POLL_MS = 1000;

type Phase =
  | { k: "starting" }
  | { k: "live"; state: LoginState }
  | { k: "failed"; text: string };

// 订阅登录：服务端在后台跑 pi 的登录流程，这里轮询它的状态并把它要的东西摆出来——
// 授权链接（+ 把授权码粘回来）、设备码（+ 等着）、进度文字。结束（成功 / 失败 / 取消）由服务端给出。
export function LoginDialog({
  id,
  name,
  onClose,
  onDone,
}: {
  id: string;
  name: string;
  onClose: () => void;
  /** 登录成功：调用方据此刷新供应商 */
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "starting" });
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const loginId = useRef<string | null>(null);
  const finished = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const token = () => loadToken();

    const apply = (state: LoginState) => {
      if (!alive) return;
      setPhase({ k: "live", state });
      if (state.status === "done") {
        finished.current = true;
        done.current();
      } else if (state.status === "running") {
        timer = window.setTimeout(poll, POLL_MS);
      } else finished.current = true;
    };
    const poll = () => {
      const lid = loginId.current;
      if (!lid) return;
      getLogin(token(), id, lid).then(apply, (e) => {
        if (alive) setPhase({ k: "failed", text: describeError(e).message });
      });
    };

    startLogin(token(), id).then(
      (state) => {
        loginId.current = state.loginId;
        apply(state);
      },
      (e) => {
        if (alive) setPhase({ k: "failed", text: describeError(e).message });
      },
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
      // 没走完就关了：告诉服务端取消，免得一直挂着
      if (loginId.current && !finished.current)
        void cancelLogin(token(), id, loginId.current).catch(() => {});
    };
  }, [id]);

  const state = phase.k === "live" ? phase.state : null;
  const prompt = state?.prompt ?? null;

  const send = async (p: LoginPrompt, value: string) => {
    const lid = loginId.current;
    if (!lid) return;
    setSending(true);
    setSendError(null);
    try {
      await answerLogin(loadToken(), id, lid, p.id, value);
      setAnswer("");
    } catch (e) {
      setSendError(describeError(e).message);
    } finally {
      setSending(false);
    }
  };

  const terminal = state
    ? state.status === "failed" || state.status === "cancelled"
    : phase.k === "failed";
  const errorText =
    phase.k === "failed"
      ? phase.text
      : state?.status === "failed"
        ? (state.error ?? "登录没有成功")
        : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`登录 ${name}`}
      description="用你的订阅账号登录，不需要 API Key"
      size="sm"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {terminal ? "关闭" : "取消"}
          </Button>
          {prompt && prompt.type !== "select" && (
            <Button
              variant="primary"
              loading={sending}
              disabled={answer.trim() === ""}
              onClick={() => void send(prompt, answer.trim())}
            >
              完成登录
            </Button>
          )}
        </>
      }
    >
      <div className="pv-login">
        {phase.k === "starting" && (
          <p className="pv-wait t-aux" role="status">
            <SpinnerIcon className="u-spin" size={14} />
            正在发起登录…
          </p>
        )}

        {state?.link && (
          <div className="pv-step">
            <span className="t-entry">打开授权页并同意授权</span>
            {state.link.instructions && (
              <span className="t-aux">{state.link.instructions}</span>
            )}
            <div className="pv-url">
              <span className="t-mono pv-url-text">{state.link.url}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copyText(state.link?.url ?? "");
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                }}
              >
                {copied ? "已复制" : "复制"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  window.open(state.link?.url, "_blank", "noopener,noreferrer")
                }
              >
                打开
              </Button>
            </div>
          </div>
        )}

        {state?.device && (
          <div className="pv-step">
            <span className="t-entry">在网页上输入下面的设备码</span>
            <span className="t-aux">{state.device.verificationUri}</span>
            <div className="pv-device t-code">{state.device.userCode}</div>
          </div>
        )}

        {prompt && (
          <div className="pv-step">
            <span className="t-entry">{prompt.message}</span>
            {prompt.type === "select" ? (
              <div className="pv-choices">
                {prompt.options?.map((o) => (
                  <Button
                    key={o.id}
                    variant="outline"
                    disabled={sending}
                    onClick={() => void send(prompt, o.id)}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            ) : (
              <Input
                large
                mono
                autoFocus
                autoComplete="off"
                type={prompt.type === "secret" ? "password" : "text"}
                value={answer}
                placeholder={prompt.placeholder ?? "授权码"}
                aria-label={prompt.message}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim() !== "" && !sending)
                    void send(prompt, answer.trim());
                }}
              />
            )}
          </div>
        )}

        {state?.status === "running" && !prompt && (
          <p className="pv-wait t-aux" role="status">
            <SpinnerIcon className="u-spin" size={14} />
            {state.message ?? "等待你在网页上完成授权…"}
          </p>
        )}

        {state?.status === "cancelled" && (
          <InlineNotice tone="warn">登录已取消。</InlineNotice>
        )}
        {(errorText || sendError) && (
          <InlineNotice tone="danger">{sendError ?? errorText}</InlineNotice>
        )}
      </div>
    </Modal>
  );
}
