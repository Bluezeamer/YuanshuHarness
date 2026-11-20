import { useEffect, useState } from "react";
import type { VariableView } from "../../../api/variables";
import {
  Button,
  copyText,
  Field,
  InlineNotice,
  Input,
  toast,
} from "../../../ui";
import { CopyIcon } from "../../../ui/icons";
import { ErrorLine } from "./actions";
import { fingerprint } from "./model";
import type { VariablesStore } from "./store";

/** 看值后自动重新遮罩的时长。 */
export const REVEAL_MS = 8000;

// 值：默认遮罩；显示与复制都是显式动作（服务端记审计，不进引用记录）；轮换换新值。这些都是操作，立即执行。
export function ValueSection({
  v,
  store,
  onRotate,
}: {
  v: VariableView;
  store: VariablesStore;
  onRotate: () => void;
}) {
  // 明文绑定它对应的写入时间：轮换后旧明文立刻不再显示
  const stamp = v.rotatedAt ?? v.createdAt;
  const [reveal, setReveal] = useState<{ value: string; stamp: string } | null>(
    null,
  );
  const shown = reveal?.stamp === stamp ? reveal.value : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = v.kind === "file";

  useEffect(() => {
    if (reveal === null) return;
    const t = setTimeout(() => setReveal(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [reveal]);

  const fetchValue = async (): Promise<string | null> => {
    setBusy(true);
    const r = await store.reveal(v.id);
    setBusy(false);
    setError(r.ok ? null : r.message);
    return r.ok ? r.data.value : null;
  };

  const toggle = async () => {
    if (shown !== null) return setReveal(null);
    const value = await fetchValue();
    if (value !== null) setReveal({ value, stamp });
  };

  const copy = async () => {
    const value = await fetchValue();
    if (value === null) return;
    const ok = await copyText(value);
    toast(
      ok
        ? file
          ? "已复制文件内容"
          : "已复制 · 值已写入剪贴板"
        : "浏览器不允许写入剪贴板",
      { tone: ok ? "ok" : "danger" },
    );
  };

  const masked = file
    ? v.file
      ? `${v.file.name} · ${v.file.lines} 行`
      : "文件"
    : (v.valueMasked ?? "••••••••");

  return (
    <>
      <Field
        label={file ? "文件内容" : "值"}
        hint="服务端加密保存，不进会话记录。显示和复制都会记入审计，显示 8 秒后自动重新遮挡。"
      >
        <div className="vr-value">
          {shown !== null && file ? (
            <pre className="vr-dump t-code">{shown}</pre>
          ) : (
            <Input
              mono
              readOnly
              aria-label={file ? "文件" : "值"}
              value={shown ?? masked}
            />
          )}
          <div className="vr-value-act">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {shown !== null ? "隐藏" : file ? "查看内容" : "显示"}
            </Button>
            <Button
              variant="ghost"
              icon={<CopyIcon />}
              disabled={busy}
              onClick={() => void copy()}
            >
              复制
            </Button>
            <Button variant="ghost" onClick={onRotate}>
              轮换
            </Button>
          </div>
        </div>
      </Field>
      <ErrorLine error={error} />
      {!v.maskable && (
        <InlineNotice tone="warn">
          值少于 8 个字符，命令输出里回显了也遮挡不住。
        </InlineNotice>
      )}
      {file && v.file && (
        <p className="vr-note t-aux">
          指纹{" "}
          <span className="t-mono">SHA256:{fingerprint(v.file.sha256)}</span>
          。命令里按内容替换，不落临时文件：
          <span className="t-mono">cat</span> 这类要路径的用法用不了。
        </p>
      )}
    </>
  );
}
