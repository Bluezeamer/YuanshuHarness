import { useEffect, useState } from "react";
import type { StudioNode } from "../../../api/studio";
import { Field, FormDialog, Input, Select } from "../../../ui";

const TAG_RE = /^[a-z][a-z0-9_-]*$/;

export interface SegmentDraft {
  title: string;
  tag: string | null;
  channel: "system" | "user";
}

// 新增 / 修改一段：名称给人看，段名是写进提示词的标签 <段名>；通道只能在新增时选。
export function SegmentDialog({
  segs,
  editing,
  open,
  onClose,
  onSubmit,
}: {
  segs: StudioNode[];
  /** 修改哪一段；null = 新增 */
  editing: StudioNode | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (d: SegmentDraft) => void;
}) {
  const [title, setTitle] = useState("");
  const [tag, setTag] = useState("");
  const [channel, setChannel] = useState<"system" | "user">("system");
  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? "新段");
    setTag(editing?.tag ?? "new-section");
    setChannel(editing?.channel ?? "system");
  }, [open, editing]);

  const bareHead = editing !== null && editing.tag === null;
  const problem = bareHead
    ? null
    : !TAG_RE.test(tag) || tag === "preamble"
      ? "段名只能用小写字母开头，含小写字母、数字、下划线或连字符（preamble 保留）"
      : segs.some((s) => s.id !== editing?.id && s.tag === tag)
        ? "已经有同名的段"
        : null;
  const ok = title.trim() !== "" && problem === null;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={editing ? "修改这一段" : "新增一段"}
      description="system 段进 system prompt；user 段随会话第一条消息送出，排在所有 system 段之后"
      confirmLabel={editing ? "确定" : "添加"}
      canSubmit={ok}
      onSubmit={() =>
        onSubmit({
          title: title.trim(),
          tag: bareHead ? null : tag,
          channel,
        })
      }
    >
      <Field label="名称" hint="在段列表里看到的名字">
        {(c) => (
          <Input
            {...c}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      {!bareHead && (
        <Field
          label="段名"
          hint={`写进提示词的标签：<${tag || "…"}> … </${tag || "…"}>`}
          {...(problem ? { error: problem } : {})}
        >
          {(c) => (
            <Input
              {...c}
              mono
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
          )}
        </Field>
      )}
      <Field label="通道">
        {(c) => (
          <Select
            {...c}
            value={channel}
            disabled={editing !== null}
            onChange={(v) => setChannel(v as "system" | "user")}
            options={[
              { value: "system", label: "system" },
              { value: "user", label: "user" },
            ]}
          />
        )}
      </Field>
    </FormDialog>
  );
}
