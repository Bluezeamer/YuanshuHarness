import { Button, Dot } from "../../../ui";

// 归档会话的输入栏替身：只读，不能发送。
export function ArchivedBar() {
  return (
    <div className="ch-archived" data-archived="">
      <Dot tone="idle" />
      <span className="ch-archived-txt">
        <span className="t-entry">已归档 · 只读</span>
        归档的会话只能查看，不能再发送消息。
      </span>
      <Button variant="ghost" disabled>
        只读
      </Button>
    </div>
  );
}
