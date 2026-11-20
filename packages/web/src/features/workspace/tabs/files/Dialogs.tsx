// 文件标签的三个对话框：取名（新建文件夹 / 重命名）、删除确认、外部拖入的同名冲突。
import { type FormEvent, useRef, useState } from "react";
import { Button, InlineNotice, Input, Modal } from "../../../../ui";
import type { ConflictChoice } from "./upload";

/** 名字的本地校验：返回错误说明，合法返回 null */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "名字不能为空";
  if (name.includes("/") || name.includes("\0")) return "名字里不能有 /";
  if (name === "." || name === "..") return "这个名字不可用";
  return null;
}

export interface NameDialogProps {
  title: string;
  initial: string;
  confirmLabel: string;
  onClose(): void;
  /** 提交；返回错误说明表示失败（对话框保持打开），null 表示成功 */
  onSubmit(name: string): Promise<string | null>;
}

export function NameDialog({
  title,
  initial,
  confirmLabel,
  onClose,
  onSubmit,
}: NameDialogProps) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const bad = nameProblem(trimmed);
    if (bad) return setError(bad);
    if (trimmed === initial) return onClose();
    setBusy(true);
    const err = await onSubmit(trimmed);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      initialFocus={input}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            form="ws-fm-name-form"
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="ws-fm-name-form" onSubmit={submit}>
        <Input
          ref={input}
          mono
          value={name}
          aria-label="名称"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onFocus={(e) => {
            // 重命名时默认选中不含扩展名的部分
            const dot = e.target.value.lastIndexOf(".");
            e.target.setSelectionRange(
              0,
              dot > 0 ? dot : e.target.value.length,
            );
          }}
        />
        {error && (
          <InlineNotice tone="danger" className="ws-fm-formerr">
            {error}
          </InlineNotice>
        )}
      </form>
    </Modal>
  );
}

export interface DeleteDialogProps {
  name: string;
  isDir: boolean;
  onClose(): void;
  /** 返回错误说明表示失败 */
  onConfirm(): Promise<string | null>;
}

export function DeleteDialog({
  name,
  isDir,
  onClose,
  onConfirm,
}: DeleteDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const err = await onConfirm();
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`删除 ${name}？`}
      description={
        isDir
          ? "文件夹及其中的全部内容会被删除，无法恢复。"
          : "删除后无法恢复。"
      }
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" loading={busy} onClick={run}>
            删除
          </Button>
        </>
      }
    >
      {error ? (
        <InlineNotice tone="danger" className="ws-fm-formerr">
          {error}
        </InlineNotice>
      ) : (
        <p className="ws-fm-hint t-aux">此操作直接作用于主机上的文件。</p>
      )}
    </Modal>
  );
}

export interface ConflictDialogProps {
  /** 目标目录（绝对路径），让用户知道往哪儿传 */
  dir: string;
  /** 会撞上已有文件的相对路径；批量上传时整批一起问，不逐个弹 */
  names: readonly string[];
  onChoose(choice: ConflictChoice): void;
  onClose(): void;
}

/** 同名文件最多列这么多条，剩下的用一句话带过 */
const CONFLICT_SHOWN = 5;

export function ConflictDialog({
  dir,
  names,
  onChoose,
  onClose,
}: ConflictDialogProps) {
  const many = names.length > 1;
  const shown = names.slice(0, CONFLICT_SHOWN);
  return (
    <Modal
      open
      onClose={onClose}
      title={many ? `${names.length} 个同名文件已存在` : "已存在同名文件"}
      description={`目标目录 ${dir} 里已经有同名文件，请选择怎么处理。`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={() => onChoose("skip")}>
            {many ? "跳过全部" : "跳过"}
          </Button>
          <Button onClick={() => onChoose("rename")}>
            {many ? "全部重命名" : "重命名"}
          </Button>
          <Button variant="primary" onClick={() => onChoose("overwrite")}>
            {many ? "覆盖全部" : "覆盖"}
          </Button>
        </>
      }
    >
      <ul className="ws-fm-dup t-code">
        {shown.map((name) => (
          <li key={name}>{name}</li>
        ))}
        {names.length > shown.length && (
          <li className="ws-fm-hint t-aux">…等 {names.length} 个文件</li>
        )}
      </ul>
      <p className="ws-fm-hint t-aux">
        重命名会在扩展名前加 (2)、(3)…，不覆盖已有内容。
      </p>
    </Modal>
  );
}
