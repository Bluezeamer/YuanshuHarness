import { useCallback, useEffect, useState } from "react";
import {
  listMcp,
  listTools,
  type McpServerInfo,
  type ToolInfo,
} from "../../../api/capabilities";
import { loadToken } from "../../../api/http";
import {
  listToolDescriptions,
  removeToolDescription,
  setToolDescription,
} from "../../../api/studio";
import {
  Button,
  Chip,
  Field,
  FormDialog,
  Table,
  Td,
  Textarea,
  Th,
} from "../../../ui";
import { ListColumn } from "../frame/layout";
import { sectionsOf } from "../tools/builtin/model";

// 工具：内置工具的描述会进入 request.tools，可以微调（只覆盖描述文本，不改行为）；MCP 服务只读预览。
// 列里显示模型实际收到的描述（覆盖优先，其次是会话创建时记下的原文）；目录里的中文名只是界面标签，不是模型收到的东西。
export function ToolsPanel() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [mcp, setMcp] = useState<McpServerInfo[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(async () => {
    const token = loadToken();
    const [t, m, o] = await Promise.all([
      listTools(token),
      listMcp(token),
      listToolDescriptions(),
    ]);
    if (t.ok) setTools(t.data);
    if (m.ok) setMcp(m.data);
    if (o.ok) {
      setOverrides(
        Object.fromEntries(
          o.data.overrides.map((d) => [d.name, d.description]),
        ),
      );
      setOriginals(o.data.originals);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = () => setEditing(null);
  const done = () => {
    close();
    void refresh();
  };
  const edit = (name: string) => {
    setEditing(name);
    setDraft(overrides[name] ?? originals[name] ?? "");
  };
  const shown = (name: string): string | null =>
    overrides[name] ?? originals[name] ?? null;
  return (
    <ListColumn>
      <p className="sd-tlede t-aux">
        这里是模型实际收到的工具描述（pi 与 Server
        注册的英文原文，覆盖后显示覆盖的）。保存后对新会话生效，已有会话在「刷新上下文」或新开后才换上；分组与「工具与能力」页一致。
      </p>
      {sectionsOf(tools).map((g) => (
        <section key={g.key} className="sd-tsec" aria-label={g.name}>
          <div className="sd-tsec-h">
            <span className="t-group">{g.name}</span>
            <span className="t-aux">{g.tools.length} 个</span>
          </div>
          <Table caption={g.name} widths={["22%", "58%", "20%"]}>
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
              {g.tools.map((t) => (
                <tr key={t.name}>
                  <Td mono>{t.name}</Td>
                  <Td>
                    {shown(t.name) === null ? (
                      <span className="t-aux">
                        还没有会话运行过，看不到模型收到的原文（{t.description}
                        ）
                      </span>
                    ) : (
                      <>
                        <span className="sd-tdesc">{shown(t.name)}</span>{" "}
                        {overrides[t.name] && <Chip tone="accent">已覆盖</Chip>}
                      </>
                    )}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={shown(t.name) === null}
                      onClick={() => edit(t.name)}
                    >
                      调优
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ))}
      <section className="sd-tsec">
        <div className="sd-tsec-h">
          <span className="t-group">MCP 服务</span>
          <span className="t-aux">{mcp.length} 个 · 只读预览</span>
        </div>
        {mcp.length === 0 ? (
          <p className="t-aux">还没有配置 MCP 服务</p>
        ) : (
          <Table caption="MCP 服务" widths={["22%", "78%"]}>
            <thead>
              <tr>
                <Th>服务</Th>
                <Th>工具</Th>
              </tr>
            </thead>
            <tbody>
              {mcp.map((m) => (
                <tr key={m.name}>
                  <Td mono>{m.name}</Td>
                  <Td>
                    {m.tools ? `${m.tools.length} 个工具` : "还没拉取工具"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      <FormDialog
        open={editing !== null}
        onClose={close}
        title={`调优工具描述：${editing ?? ""}`}
        description="只覆盖 description 文本，不改工具行为；保存后对新会话生效，已有会话在刷新上下文后换上"
        confirmLabel="保存"
        onSubmit={() =>
          editing && void setToolDescription(editing, draft).then(done)
        }
        aside={
          editing !== null && overrides[editing] !== undefined ? (
            <Button
              variant="ghost"
              size="lg"
              onClick={() => void removeToolDescription(editing).then(done)}
            >
              恢复默认
            </Button>
          ) : undefined
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
      </FormDialog>
    </ListColumn>
  );
}
