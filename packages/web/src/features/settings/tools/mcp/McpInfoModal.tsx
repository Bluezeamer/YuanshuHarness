import type { McpView } from "../../../../api/mcpLibrary";
import { Button, Modal } from "../../../../ui";
import { relTime } from "../common/format";
import { POL_LABEL } from "../common/policy";
import {
  EXPOSURE_NOTE,
  fullName,
  NO_DESCRIPTION,
  statusOf,
  targetOf,
  toolCount,
} from "./model";

// MCP 详情（只读，宽 880px）：六格事实 + 握手返回的工具全名与描述。
// 握手只返回部分工具时标「显示 N / M」，不补写未返回的描述。
export function McpInfoModal({
  server: m,
  onEdit,
  onClose,
}: {
  server: McpView;
  onEdit: () => void;
  onClose: () => void;
}) {
  const tools = m.tools ?? [];
  const total = toolCount(m);
  const facts: [string, string][] = [
    ["传输", m.transport],
    [
      "版本",
      m.transport === "http"
        ? "远端服务"
        : m.source === null
          ? "不可固定"
          : m.pinned
            ? `${m.version} · 已固定`
            : "浮动",
    ],
    ["暴露", m.exposure],
    ["审批", POL_LABEL[m.approval]],
    ["工具", `${total} 个`],
    [
      "检测",
      m.handshake
        ? m.handshake.ok
          ? `${m.handshake.ms}ms · ${relTime(m.handshake.at)}`
          : statusOf(m, null).text
        : "从未",
    ],
  ];
  return (
    <Modal
      open
      onClose={onClose}
      title={m.name}
      size="xl"
      footer={
        <>
          <span className="st-tl-dim t-aux">{EXPOSURE_NOTE[m.exposure]}</span>
          <span className="st-tl-spacer" />
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={onEdit}>编辑配置</Button>
        </>
      }
    >
      <div className="st-tl-minfo">
        <div className="st-tl-msum t-aux">
          <span>
            {m.description === NO_DESCRIPTION ? (
              <span className="st-tl-mono st-tl-dim t-mono">
                {NO_DESCRIPTION}
              </span>
            ) : (
              m.description
            )}
          </span>
          <span className="st-tl-mono st-tl-ell t-mono" title={targetOf(m)}>
            {targetOf(m)}
          </span>
        </div>
        <dl className="st-tl-facts6" aria-label="事实">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="t-aux">{k}</dt>
              <dd className="t-mono">{v}</dd>
            </div>
          ))}
        </dl>
        {tools.length > 0 ? (
          <>
            <div className="st-tl-block-h t-group">
              <span>工具</span>
              <span className="st-tl-mono t-mono" data-testid="tool-shown">
                显示 {tools.length} / {total}
              </span>
            </div>
            <table className="st-tl-mtools t-aux">
              <caption className="sr-only">握手返回的工具</caption>
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">描述</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.name}>
                    <td className="st-tl-mono st-tl-fg t-mono">
                      {fullName(m.name, t.name)}
                    </td>
                    <td>{t.description || "握手未返回描述"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {total > tools.length && (
              <p className="st-tl-dim t-aux">
                其余 {total - tools.length} 个工具握手没有返回描述。
              </p>
            )}
          </>
        ) : (
          <p className="st-tl-dim t-aux">
            {m.enabled
              ? "握手后才有工具。先检测一次。"
              : "已禁用，未建立连接。"}
          </p>
        )}
      </div>
    </Modal>
  );
}
