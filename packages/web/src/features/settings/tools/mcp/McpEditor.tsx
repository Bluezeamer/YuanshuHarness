import { useEffect, useRef, useState } from "react";
import type {
  McpDiagnostic,
  McpPreview,
  McpRef,
  McpView,
} from "../../../../api/mcpLibrary";
import { Button, InlineNotice, Modal, Textarea } from "../../../../ui";
import { confJson, TEMPLATE_KINDS, templateText } from "./model";
import type { McpStore } from "./store";

const DEBOUNCE_MS = 200;

const REF_KIND: Record<McpRef["kind"], string> = {
  preset: "提示词预设",
  directory: "Directory",
};

export interface McpEditorProps {
  store: McpStore;
  /** 编辑现有条目；缺省是添加。 */
  editing?: McpView;
  /** 保存成功，参数是服务端返回的最新状态（改名后 name 已是新名）。 */
  onDone: (saved: McpView) => void;
  onClose: () => void;
}

// 配置入口是一段 mcpServers JSON：名称取自键，描述取自包元数据 / 握手，这里没有名称与描述输入。
export function McpEditor({ store, editing, onDone, onClose }: McpEditorProps) {
  const [text, setText] = useState(
    editing ? confJson(editing) : templateText("stdio"),
  );
  const [diags, setDiags] = useState<McpDiagnostic[]>([]);
  const [preview, setPreview] = useState<McpPreview | null>(null);
  const [valid, setValid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [refs, setRefs] = useState<McpRef[]>([]);
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);

  // 边输入边校验：防抖后调服务端，同一套规则；乱序返回只认最后一次。
  useEffect(() => {
    const mine = ++ticket.current;
    setValid(false);
    const t = setTimeout(() => {
      void store.validate(text, editing?.name).then((r) => {
        if (mine !== ticket.current) return;
        if (!r.ok) {
          setDiags([]);
          setPreview(null);
          return setFailure(r.message);
        }
        setFailure(null);
        setDiags(r.data.diagnostics);
        setPreview(r.data.preview);
        setValid(r.data.ok);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [store, text, editing?.name]);

  const submit = async () => {
    setBusy(true);
    setRefs([]);
    const r = editing
      ? await store.update(editing.name, text)
      : await store.create(text);
    setBusy(false);
    if (r.ok) return onDone(r.data);
    const body = r.body as {
      references?: McpRef[];
      diagnostics?: McpDiagnostic[];
    } | null;
    if (r.code === "mcp_referenced") setRefs(body?.references ?? []);
    if (body?.diagnostics) setDiags(body.diagnostics);
    setFailure(r.message);
  };

  const shown = diags.filter(
    (d) => d.level === "error" || d.level === "warning",
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `编辑配置 · ${editing.name}` : "添加 MCP 服务"}
      size="lg"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() => void submit()}
          >
            {editing ? "保存" : "添加"}
          </Button>
        </>
      }
    >
      <div className="st-tl-form">
        <div className="st-tl-jrow">
          <span className="st-tl-dim t-aux">配置 · mcpServers 条目</span>
          <span className="st-tl-spacer" />
          {TEMPLATE_KINDS.map((k) => (
            <Button
              key={k}
              size="sm"
              data-tpl={k}
              onClick={() => setText(templateText(k))}
            >
              {k}
            </Button>
          ))}
          <span className="st-tl-mono t-mono">{`\${VAR} 取 server 环境`}</span>
        </div>
        <Textarea
          mono
          rows={11}
          spellCheck={false}
          aria-label="MCP 配置 JSON"
          aria-invalid={shown.some((d) => d.level === "error") || undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <dl className="st-tl-preview st-tl-preview-4" aria-label="解析预览">
          <div>
            <dt className="t-aux">名称</dt>
            <dd className="t-mono" data-testid="mcp-pv-name">
              {preview?.name ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="t-aux">传输</dt>
            <dd className="t-mono" data-testid="mcp-pv-transport">
              {preview?.transport ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="t-aux">目标</dt>
            <dd
              className="t-mono"
              data-testid="mcp-pv-target"
              title={preview?.target}
            >
              {preview?.target ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="t-aux">附带</dt>
            <dd className="t-mono" data-testid="mcp-pv-extra">
              {preview
                ? [
                    preview.envCount ? `env ${preview.envCount}` : "",
                    preview.headerCount ? `headers ${preview.headerCount}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"
                : "—"}
            </dd>
          </div>
        </dl>
        {shown.length > 0 && (
          <ul className="st-tl-diags t-aux" aria-label="校验结果">
            {shown.map((d) => (
              <li
                key={`${d.code}:${d.field ?? ""}:${d.message}`}
                data-level={d.level}
              >
                <span className="st-tl-mono t-mono">
                  {d.level === "error" ? "错误" : "提示"}
                </span>
                {d.message}
              </li>
            ))}
          </ul>
        )}
        {failure && diags.length === 0 && (
          <InlineNotice tone="danger">{failure}</InlineNotice>
        )}
        {refs.length > 0 && (
          <div className="st-tl-refs t-aux">
            <InlineNotice tone="danger">{failure}</InlineNotice>
            <ul aria-label="引用位置">
              {refs.map((r) => (
                <li key={`${r.kind}:${r.id}:${r.detail}`}>
                  <span className="st-tl-mono t-mono">{REF_KIND[r.kind]}</span>
                  {r.name} · {r.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="st-tl-dim t-aux">
          {editing
            ? "改完重新握手；固定的版本写在 args 里，换了包就不再是固定。"
            : "添加后可以在展开区试装并固定版本。"}
        </p>
      </div>
    </Modal>
  );
}
