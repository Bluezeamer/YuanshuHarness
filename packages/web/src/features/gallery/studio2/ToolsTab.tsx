import { useState } from "react";
import {
  Button,
  Chip,
  Field,
  Modal,
  Table,
  Td,
  Textarea,
  Th,
  toast,
} from "../../../ui";
import { ListColumn } from "../../settings/frame/layout";

const TOOLS: [string, string][] = [
  ["read", "Read file contents"],
  ["bash", "Execute bash commands"],
  ["edit", "Make precise edits"],
  ["write", "Create or overwrite files"],
  ["grep", "Search file contents"],
  ["transfer_files", "Transfer files between two directories (across hosts)"],
];
const MCP: [string, string][] = [
  ["filesystem", "9 个工具"],
  ["github", "还没拉取工具"],
];

// 工具：内置工具的描述会进入 request.tools，可以微调（只覆盖描述文本）；MCP 服务只读预览。
export function ToolsTab() {
  const [over, setOver] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const open = (name: string, desc: string) => {
    setEditing(name);
    setDraft(over[name] ?? desc);
  };
  return (
    <ListColumn>
      <section className="sp-tsec">
        <div className="sp-tsec-h">
          <span className="t-group">内置工具</span>
          <span className="t-aux">
            {TOOLS.length} 个 · 描述会进入 request.tools，保存后下一条消息生效
          </span>
        </div>
        <Table caption="内置工具" widths={["22%", "58%", "20%"]}>
          <thead>
            <tr>
              <Th>工具</Th>
              <Th>描述</Th>
              <Th>
                <span className="sr-only">操作</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {TOOLS.map(([name, desc]) => (
              <tr key={name}>
                <Td mono>{name}</Td>
                <Td>
                  {over[name] ?? desc}{" "}
                  {over[name] && <Chip tone="accent">已覆盖</Chip>}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => open(name, desc)}
                  >
                    调优
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      <section className="sp-tsec">
        <div className="sp-tsec-h">
          <span className="t-group">MCP 服务</span>
          <span className="t-aux">{MCP.length} 个 · 只读预览</span>
        </div>
        <Table caption="MCP 服务" widths={["22%", "78%"]}>
          <thead>
            <tr>
              <Th>服务</Th>
              <Th>工具</Th>
            </tr>
          </thead>
          <tbody>
            {MCP.map(([name, n]) => (
              <tr key={name}>
                <Td mono>{name}</Td>
                <Td>{n}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="md"
        title={`调优工具描述：${editing ?? ""}`}
        description="只覆盖 description 文本，不改工具行为；保存后所有会话的下一条消息生效"
        footer={
          <>
            {editing !== null && over[editing] !== undefined && (
              <Button
                variant="ghost"
                size="lg"
                onClick={() => {
                  setOver(({ [editing]: _, ...rest }) => rest);
                  setEditing(null);
                }}
              >
                恢复默认
              </Button>
            )}
            <span className="sp-sp" />
            <Button variant="ghost" size="lg" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                if (editing) setOver({ ...over, [editing]: draft });
                setEditing(null);
                toast("已保存", { tone: "ok" });
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <Field label="描述">
          {(c) => (
            <Textarea
              {...c}
              mono
              rows={8}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
        </Field>
      </Modal>
    </ListColumn>
  );
}
