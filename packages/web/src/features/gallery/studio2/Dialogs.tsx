import { useState } from "react";
import {
  Button,
  Field,
  InlineNotice,
  Input,
  Modal,
  Segmented,
  Textarea,
  toast,
} from "../../../ui";
import { card, type Segment } from "../studioData";
import type { Preset, Store } from "./data";

/** 新建 / 重命名：名字与一句描述。 */
export function NameDialog({
  open,
  title,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: { name: string; desc: string };
  onClose: () => void;
  onSubmit: (v: { name: string; desc: string }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [desc, setDesc] = useState(initial.desc);
  const ok = name.trim() !== "";
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!ok}
            onClick={() => onSubmit({ name: name.trim(), desc: desc.trim() })}
          >
            确定
          </Button>
        </>
      }
    >
      <div className="sp-dlg">
        <Field label="名称">
          {(c) => (
            <Input
              {...c}
              large
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="描述">
          {(c) => (
            <Input
              {...c}
              large
              value={desc}
              placeholder="列表卡片上的一句话（可不填）"
              onChange={(e) => setDesc(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/** 新增段 / 改段：名字、标签（<tag>）、通道。 */
export function SegDialog({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: Segment | null;
  onClose: () => void;
  onSubmit: (v: Pick<Segment, "title" | "tag" | "channel">) => void;
}) {
  const [title, setTitle] = useState(editing?.title ?? "");
  const [tag, setTag] = useState(editing?.tag ?? "");
  const [channel, setChannel] = useState<"system" | "user">(
    editing?.channel ?? "system",
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={editing ? "改这一段" : "新增一段"}
      description="段是提示词的加载单元：按顺序拼接，标签会成为包住它的 XML 标签"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={title.trim() === ""}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                tag: tag.trim() === "" ? null : tag.trim(),
                channel,
              })
            }
          >
            确定
          </Button>
        </>
      }
    >
      <div className="sp-dlg">
        <Field label="段名">
          {(c) => (
            <Input
              {...c}
              large
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <Field label="标签">
          {(c) => (
            <Input
              {...c}
              large
              mono
              value={tag}
              placeholder="留空 = 不加标签"
              onChange={(e) => setTag(e.target.value)}
            />
          )}
        </Field>
        <Field label="通道">
          <Segmented
            aria-label="通道"
            options={[
              { value: "system", label: "system" },
              { value: "user", label: "user" },
            ]}
            value={channel}
            onChange={setChannel}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** 改卡片库里的一张：改它会影响所有引用它的预设。 */
export function CardEditDialog({
  id,
  onClose,
  onSaved,
}: {
  id: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const c = id ? card(id) : null;
  const [title, setTitle] = useState(c?.title ?? "");
  const [body, setBody] = useState(c?.body ?? "");
  return (
    <Modal
      open={c !== null}
      onClose={onClose}
      size="md"
      title="编辑卡片"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              if (c) Object.assign(c, { title: title.trim() || c.title, body });
              toast("卡片已保存", { tone: "ok" });
              onSaved();
              onClose();
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="sp-dlg">
        {c && c.usedBy > 1 && (
          <InlineNotice>
            这张卡片被 {c.usedBy} 个预设引用，改动会同时影响它们。
          </InlineNotice>
        )}
        <Field label="标题">
          {(f) => (
            <Input
              {...f}
              large
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <Field label="内容">
          {(f) => (
            <Textarea
              {...f}
              mono
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/**
 * 激活全局版本。磁盘上的 ~/.ys/AGENTS.md 被手改过（不在任何版本里）时先问：
 * 另存为新版本再激活 / 直接覆盖 / 取消。其余情况直接激活。
 */
export function useActivate(store: Store) {
  const [asking, setAsking] = useState<Preset | null>(null);
  const done = (p: Preset) => {
    store.activate(p.id);
    toast(
      p.kind === "gmd"
        ? `已激活「${p.name}」，已写入 ~/.ys/AGENTS.md`
        : `已将「${p.name}」设为生效`,
      { tone: "ok" },
    );
  };
  const request = (p: Preset) => {
    if (p.kind === "gmd" && store.disk) setAsking(p);
    else done(p);
  };
  const dialog = (
    <Modal
      open={asking !== null}
      onClose={() => setAsking(null)}
      size="sm"
      title="磁盘上的文件被改动过"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={() => setAsking(null)}>
            取消
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              if (asking) done(asking);
              setAsking(null);
            }}
          >
            直接覆盖
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              if (asking) {
                store.add("gmd", "从磁盘导入", "激活前磁盘上手改过的内容", [
                  {
                    id: "body",
                    title: "正文",
                    tag: null,
                    channel: "system",
                    items: [{ kind: "card", id: "agentsmd" }],
                  },
                ]);
                done(asking);
              }
              setAsking(null);
            }}
          >
            另存为新版本再激活
          </Button>
        </>
      }
    >
      <p className="t-plain">
        <span className="t-mono">~/.ys/AGENTS.md</span>{" "}
        {`里有不在任何版本里的修改。激活「${asking?.name ?? ""}」会把它重写成这个版本的内容，现有修改会丢掉。`}
      </p>
    </Modal>
  );
  return { request, dialog };
}
