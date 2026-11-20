// 页面弹出了 alert / confirm / prompt / beforeunload：页面被它卡住，要有人答了才继续。
// agent 与你都能答，先答先得：别处答了，页面状态一更新弹窗就消失。
// 关闭弹窗（Esc、右上角）等同于取消：对话框还挂在页面状态里，不答它会立刻又弹出来。
import { useState } from "react";
import type { PageDialog } from "../../../../api/browser";
import { Button, Input, Modal } from "../../../../ui";

export interface DialogPromptProps {
  item: PageDialog;
  /** 页面当前地址，用来写明是谁在问 */
  url: string;
  /** 失败的提示由调用方弹出；成功后弹窗随页面状态更新自行消失 */
  onAnswer(accept: boolean, text?: string): Promise<void>;
}

const TITLE: Record<PageDialog["type"], string> = {
  alert: "页面提示",
  confirm: "页面请求确认",
  prompt: "页面请求输入",
  beforeunload: "要离开这个页面吗？",
};

/** 确定 / 取消两个按钮的字：alert 只有一个，beforeunload 是「离开 / 留下」。 */
const LABEL: Record<PageDialog["type"], { yes: string; no: string | null }> = {
  alert: { yes: "知道了", no: null },
  confirm: { yes: "确定", no: "取消" },
  prompt: { yes: "确定", no: "取消" },
  beforeunload: { yes: "离开", no: "留在页面" },
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || "页面";
  } catch {
    return "页面";
  }
};

export function DialogPrompt({ item, url, onAnswer }: DialogPromptProps) {
  const [text, setText] = useState(item.defaultValue);
  const [doing, setDoing] = useState<"yes" | "no" | null>(null);
  const label = LABEL[item.type];

  const answer = async (accept: boolean) => {
    setDoing(accept ? "yes" : "no");
    await onAnswer(accept, accept && item.type === "prompt" ? text : undefined);
    setDoing(null);
  };

  return (
    <Modal
      open
      onClose={() => doing === null && void answer(false)}
      size="sm"
      title={TITLE[item.type]}
      description={`${hostOf(url)} 的页面弹出了它，页面被卡住，答了才会继续。`}
      dismissOnScrim={false}
      footer={
        <>
          {label.no !== null && (
            <div className="u-form-aside">
              <Button
                variant="ghost"
                size="lg"
                loading={doing === "no"}
                disabled={doing !== null}
                onClick={() => void answer(false)}
              >
                {label.no}
              </Button>
            </div>
          )}
          <Button
            variant="primary"
            size="lg"
            loading={doing === "yes"}
            disabled={doing !== null}
            onClick={() => void answer(true)}
          >
            {label.yes}
          </Button>
        </>
      }
    >
      <div className="u-form">
        {item.message !== "" && (
          <p className="ws-dlg-msg t-plain">{item.message}</p>
        )}
        {item.type === "prompt" && (
          <Input
            large
            aria-label="回答"
            value={text}
            disabled={doing !== null}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && doing === null) void answer(true);
            }}
          />
        )}
      </div>
    </Modal>
  );
}
