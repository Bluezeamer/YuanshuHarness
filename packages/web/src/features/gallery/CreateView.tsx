import { useState } from "react";
import {
  Button,
  Field,
  InlineNotice,
  Input,
  Kbd,
  Modal,
  Select,
  SummaryRow,
  Switch,
} from "../../ui";

const AGENTS = [
  { value: "coder-full", label: "coder-full", hint: "默认" },
  { value: "reviewer", label: "reviewer" },
  { value: "local-qwen", label: "local-qwen" },
];

// 样张 1：创建会话。名称与 Agent 直接露出，次要设置折成摘要行。
export function CreateView() {
  const [open, setOpen] = useState(true);
  const [agent, setAgent] = useState("coder-full");
  // ?gallery=create&error 直接打开错误态（开关被弹窗盖住时用）
  const [error, setError] = useState(() =>
    new URLSearchParams(location.search).has("error"),
  );
  const [name, setName] = useState("");
  return (
    <div className="gl-blank">
      <div className="gl-fields">
        <Button variant="primary" onClick={() => setOpen(true)}>
          打开「新对话」弹窗
        </Button>
        <div className="t-aux">
          <Switch checked={error} onChange={setError} aria-label="错误态" />
          {" 显示错误态"}
        </div>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="新对话"
        footer={
          <>
            <span className="gl-foot-hint t-mono">
              <Kbd>Ctrl</Kbd> <Kbd>↵</Kbd> 创建
            </span>
            <Button variant="ghost" size="lg" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="lg" onClick={() => setOpen(false)}>
              创建
            </Button>
          </>
        }
      >
        <div className="gl-fields">
          <Field
            label="名称"
            hint="可不填，首条消息会自动命名"
            error={error ? "名称已被另一个会话使用" : undefined}
          >
            {(c) => (
              <Input
                {...c}
                large
                value={name}
                placeholder="例如：修复登录态丢失"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Agent" hint="创建后不能更换。">
            {(c) => (
              <Select
                {...c}
                size="lg"
                value={agent}
                options={AGENTS}
                onChange={setAgent}
              />
            )}
          </Field>
        </div>
        <div className="gl-sep" />
        <SummaryRow
          label="模型"
          value="Qwen3.8-27B"
          note="思考 low"
          onOpen={() => {}}
          onReset={() => {}}
        />
        <SummaryRow
          label="权限"
          value="规则审批"
          note="跟随全局默认"
          onOpen={() => {}}
        />
        <SummaryRow
          label="能力"
          value="Agent 基线，12 项"
          note="无改动"
          onOpen={() => {}}
        />
        <SummaryRow
          label="模式"
          value="plan、review"
          note="未启用"
          onOpen={() => {}}
        />
        {error && (
          <>
            <div className="gl-sep" />
            <SummaryRow
              label="目录"
              tone="danger"
              value={<span className="t-mono u-mono">/path/to/project</span>}
              note="目录不存在"
              onOpen={() => {}}
            />
            <InlineNotice tone="danger">
              目录不存在，创建前要先选一个有效目录。
            </InlineNotice>
          </>
        )}
      </Modal>
    </div>
  );
}
