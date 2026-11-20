import { useRef, useState } from "react";
import type { VarKind } from "../../../api/variables";
import { Button, Field, Input, Segmented } from "../../../ui";
import { bytesLabel, VALUE_MAX, VALUE_MIN } from "./model";

export interface PickedFile {
  name: string;
  text: string;
  bytes: number;
  lines: number;
}

export interface ValueDraft {
  kind: VarKind;
  text: string;
  file: PickedFile | null;
}

export const emptyDraft = (kind: VarKind = "text"): ValueDraft => ({
  kind,
  text: "",
  file: null,
});

type Read = { ok: true; data: PickedFile } | { ok: false; message: string };

// 只收文本：按 UTF-8 解码，出现 NUL 或替换字符说明是二进制。行数口径与服务端一致。
export function readTextFile(file: File): Promise<Read> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, message: "读取文件失败" });
    reader.onload = () => {
      const text = String(reader.result ?? "");
      if (text === "") return resolve({ ok: false, message: "文件是空的" });
      if (text.includes("\0") || text.includes("\uFFFD"))
        return resolve({ ok: false, message: "只收文本文件，这个像是二进制" });
      if (text.length > VALUE_MAX)
        return resolve({
          ok: false,
          message: `文件太大：最多 ${bytesLabel(VALUE_MAX)}`,
        });
      resolve({
        ok: true,
        data: {
          name: file.name,
          text,
          bytes: new TextEncoder().encode(text).length,
          lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
        },
      });
    };
    reader.readAsText(file);
  });
}

/** 校验草稿；通过返回 null，否则给一句话。 */
export function draftError(d: ValueDraft): string | null {
  if (d.kind === "file")
    return d.file ? null : "先选择一个文件：私钥、kubeconfig 或证书 PEM。";
  const v = d.text.trim();
  if (v.length < VALUE_MIN) return `值至少 ${VALUE_MIN} 位。`;
  if (v.length > VALUE_MAX) return `值最多 ${bytesLabel(VALUE_MAX)}。`;
  return null;
}

export interface ValueFieldProps {
  draft: ValueDraft;
  onChange: (next: ValueDraft) => void;
  /** 类型不可改（轮换：类型创建后固定）。 */
  lockKind?: boolean;
  /** 轮换时提示当前文件名。 */
  currentFile?: string | undefined;
}

// 添加与轮换共用：类型选择 + 文本值 / 文件上传。内容不回显，保存后只给指纹。
export function ValueField({
  draft,
  onChange,
  lockKind = false,
  currentFile,
}: ValueFieldProps) {
  const picker = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    const r = await readTextFile(f);
    setFileError(r.ok ? null : r.message);
    if (r.ok) onChange({ ...draft, file: r.data });
  };

  return (
    <>
      <Field label="类型">
        <Segmented
          size="sm"
          aria-label="变量类型"
          value={draft.kind}
          disabled={lockKind}
          onChange={(kind) => onChange({ ...emptyDraft(kind) })}
          options={[
            { value: "text", label: "文本" },
            { value: "file", label: "文件" },
          ]}
        />
      </Field>
      {draft.kind === "text" ? (
        <Field label="值" hint="保存后只回显指纹">
          {(c) => (
            <Input
              {...c}
              type="password"
              autoComplete="new-password"
              placeholder="粘贴要托管的值"
              value={draft.text}
              onChange={(e) => onChange({ ...draft, text: e.target.value })}
            />
          )}
        </Field>
      ) : (
        <Field
          label="文件"
          hint={`只收文本 · ≤ ${bytesLabel(VALUE_MAX)} · 命令里按内容替换（暂不落临时文件）`}
          error={fileError}
        >
          <div className="vr-drop">
            <Button size="sm" onClick={() => picker.current?.click()}>
              选择文件
            </Button>
            <span className="t-aux">
              {draft.file
                ? `${draft.file.name} · ${bytesLabel(draft.file.bytes)} · ${draft.file.lines} 行`
                : `未选择${currentFile ? ` · 当前 ${currentFile}` : " · 私钥、kubeconfig、证书 PEM"}`}
            </span>
            <input
              ref={picker}
              type="file"
              hidden
              aria-label="上传文件"
              accept=".pem,.key,.json,.yaml,.yml,.conf,.ini,.txt,.crt"
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </Field>
      )}
    </>
  );
}
