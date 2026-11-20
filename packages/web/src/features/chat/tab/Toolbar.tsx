import type { ReactNode } from "react";
import { type InsertApi, PlusMenu } from "./InsertMenus";
import { ModelPicker } from "./ModelPicker";
import { ModePicker } from "./ModePicker";
import { currentModel } from "./models";
import { PermPicker } from "./PermPicker";
import type { ChatConfig } from "./useChatConfig";

// 工具行，自左向右：附件（+）· 模式 · 审批 …… 模型与推理档位 · 末尾（运行中的停止、发送）。
// 斜杠命令没有按钮：在空输入框里按 / 调出；MCP 状态在斜杠菜单里。
export function Toolbar({
  cfg,
  insert,
  end,
}: {
  cfg: ChatConfig;
  insert: InsertApi;
  end: ReactNode;
}) {
  const current = currentModel(cfg.config?.model, cfg.defaultModel);
  return (
    <div className="ch-toolrow">
      <PlusMenu insert={insert} />
      <ModePicker sessionId={cfg.sessionId} />
      <PermPicker cfg={cfg} />
      <span className="ch-sp" />
      <ModelPicker cfg={cfg} current={current} />
      {end}
    </div>
  );
}
