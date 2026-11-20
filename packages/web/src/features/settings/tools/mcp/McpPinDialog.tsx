import { useState } from "react";
import type { McpView, StepResult } from "../../../../api/mcpLibrary";
import { Button, InlineNotice, Modal } from "../../../../ui";
import { CheckSteps } from "./CheckSteps";
import type { McpStore } from "./store";

type Steps = { start: StepResult; handshake: StepResult; list: StepResult };

// 试装并固定：在 Server 本机解析版本、安装并跑一次；成功才把 pkg@版本 写回命令，失败不写、仍标浮动。
export function McpPinDialog({
  server: m,
  store,
  onDone,
  onClose,
}: {
  server: McpView;
  store: McpStore;
  onDone: (version: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    message: string;
    steps: Steps | null;
  } | null>(null);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    const r = await store.tryPin(m.name);
    setBusy(false);
    if (r.ok) return onDone(r.data.version);
    const steps = (r.body as { steps?: Steps } | null)?.steps ?? null;
    setFailure({ message: r.message, steps });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${m.pinned ? "重新固定" : "试装并固定"} · ${m.name}`}
      description="解析最新版 → 在 Server 本机安装一次 → 启动、握手、列工具。成功才写回配置里的 pkg@版本。"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            {failure ? "重试" : "开始试装"}
          </Button>
        </>
      }
    >
      <ol className="st-tl-pinsteps t-aux" aria-label="试装流程">
        <li>解析版本</li>
        <li>在 Server 本机安装并运行</li>
        <li>启动 → 握手 → 列工具</li>
      </ol>
      {failure && (
        <div className="st-tl-pinfail">
          <InlineNotice tone="danger">
            <p>{failure.message}</p>
            <p className="st-tl-dim t-aux">没有写回配置，仍是浮动。</p>
          </InlineNotice>
          {failure.steps && <CheckSteps steps={failure.steps} />}
        </div>
      )}
    </Modal>
  );
}
