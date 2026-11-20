import { useCallback, useEffect, useState } from "react";
import { loadToken } from "../../../api/http";
import {
  getModelsJson,
  type ModelsJsonDiff,
  type ModelsJsonView,
} from "../../../api/providers";
import { Button, Chip, Empty } from "../../../ui";
import { describeError } from "./errors";

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; view: ModelsJsonView };

const OP: Record<ModelsJsonDiff["op"], { sign: string; label: string }> = {
  add: { sign: "+", label: "新增" },
  remove: { sign: "−", label: "删除" },
  replace: { sign: "~", label: "修改" },
};

// 差异值可能很大（整个 provider 段），截断显示，完整内容看下面的 live 预览。
function show(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return "—";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

export function ModelsJsonPane() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      setState({ phase: "ready", view: await getModelsJson(loadToken()) });
    } catch (e) {
      setState({ phase: "error", message: describeError(e).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading")
    return <Empty title="正在生成预览…" role="status" />;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取 models.json 预览失败"
        description={state.message}
        action={<Button onClick={() => void load()}>重试</Button>}
      />
    );

  const { path, exists, diff, live } = state.view;
  const providers = Object.keys(live.providers);
  return (
    <div className="st-json">
      <section className="st-block" aria-label="models.json">
        <header className="st-block-h t-group">
          <span>models.json</span>
          <span className="t-mono">preview</span>
          <span className="pv-grow" />
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            刷新
          </Button>
        </header>
        <p className="pv-note t-aux">
          只读预览：元枢目前不会写入这个文件。下面是按当前配置生成的内容，以及它与磁盘文件的差异。
        </p>
        <p className="st-json-path t-aux">
          <Chip tone="warn">预览 · 未写盘</Chip>
          <span className="t-mono">{path}</span>
          <span className="t-aux">{exists ? "文件已存在" : "文件不存在"}</span>
        </p>
      </section>

      <section className="st-block" aria-label="与磁盘文件的差异">
        <header className="st-block-h t-group">
          <span>与磁盘文件的差异</span>
          <span className="t-mono">{diff.length} 处</span>
        </header>
        {diff.length === 0 ? (
          <p className="pv-note t-aux">
            {exists
              ? "预览与磁盘文件一致。"
              : "磁盘上还没有这个文件，也没有需要生成的内容。"}
          </p>
        ) : (
          <ul className="st-diff" aria-label="差异">
            {diff.map((d) => (
              <li
                key={`${d.op}:${d.path}`}
                className="st-diff-row t-aux"
                data-op={d.op}
              >
                <span
                  className="st-diff-sign t-mono"
                  role="img"
                  aria-label={OP[d.op].label}
                >
                  {OP[d.op].sign}
                </span>
                <span className="t-mono st-diff-path">{d.path}</span>
                {d.op !== "add" && (
                  <code className="st-diff-val t-mono" data-side="before">
                    {show(d.before)}
                  </code>
                )}
                {d.op !== "remove" && (
                  <code className="st-diff-val t-mono" data-side="after">
                    {show(d.after)}
                  </code>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="st-block" aria-label="将生成的内容">
        <header className="st-block-h t-group">
          <span>将生成的内容</span>
          <span className="t-mono">{providers.length} 个供应商</span>
        </header>
        <pre className="st-json-live t-mono">
          {JSON.stringify(live, null, 2)}
        </pre>
      </section>
    </div>
  );
}
