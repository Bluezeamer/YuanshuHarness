import { useState } from "react";
import { importGlobalAgentsMd } from "../../../api/agentsMd";
import { loadToken } from "../../../api/http";
import {
  copyPreset,
  deletePreset,
  type PresetKind,
  type StudioPreset,
} from "../../../api/studio";
import { Button, Chip, ConfirmDialog, InlineNotice, toast } from "../../../ui";
import { CardGrid, type CardGridItem } from "../frame/CardGrid";
import type { useActivate, useGlobalFile } from "./activate";
import { PresetNameDialog } from "./PresetNameDialog";
import { useStudio } from "./useStudio";

export const NOUN: Record<PresetKind, string> = {
  "global-agentsmd": "版本",
  "project-agentsmd": "模板",
  "global-extra": "版本",
  agent: "Agent",
  mode: "模式",
};

/** 同一时间只有一个生效的种类 */
export const isVersioned = (k: PresetKind) =>
  k === "global-agentsmd" || k === "global-extra";

const when = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const metaOf = (p: StudioPreset) => {
  if (p.kind === "agent")
    return (
      <>
        <span>
          {p.capabilities ? `${p.capabilities.length} 项能力` : "能力不限制"}
        </span>
        <span>{p.refCount ? `${p.refCount} 个会话在用` : "未被引用"}</span>
      </>
    );
  if (p.kind === "mode") {
    const ops = [
      p.capabilities && `限定为 ${p.capabilities.length}`,
      p.capsAdd.length > 0 && `增加 ${p.capsAdd.length}`,
      p.capsRemove.length > 0 && `减少 ${p.capsRemove.length}`,
    ].filter(Boolean);
    return <span>{ops.length ? ops.join(" · ") : "不改变能力"}</span>;
  }
  return (
    <>
      <span>更新于 {when(p.updatedAt)}</span>
      {p.kind === "project-agentsmd" && <span>创建工作区时可选</span>}
      {p.kind === "global-extra" && <span>按模型路由</span>}
    </>
  );
};

const LEDE: Partial<Record<PresetKind, string>> = {
  "global-agentsmd":
    "全局约定：同一时间只有一个版本生效，激活时写入 ~/.ys/AGENTS.md，对所有会话生效。",
  "project-agentsmd":
    "这里只存模板：创建工作区时选一个作为起点，写进主目录的 AGENTS.md，之后归项目自己，这里不再管。",
  "global-extra":
    "不写任何文件：每次建会话按当时的模型选出内容，注入对话开头，排在全局 AGENTS.md 之后、项目 AGENTS.md 之前。同一时间只有一个版本生效。",
};

// 一个种类的列表页：卡片网格，点开进编辑页。操作都在卡片的「⋯」里。
export function PresetList({
  kind,
  onOpen,
  activate,
  file,
}: {
  kind: PresetKind;
  onOpen: (id: string) => void;
  activate: ReturnType<typeof useActivate>;
  file: ReturnType<typeof useGlobalFile>;
}) {
  const { presets, reload } = useStudio();
  const noun = NOUN[kind];
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<StudioPreset | null>(null);
  const [deleting, setDeleting] = useState<StudioPreset | null>(null);
  const list = presets.filter((p) => p.kind === kind);
  const versioned = isVersioned(kind);

  const run = async (f: () => Promise<{ ok: boolean }>, fail: string) => {
    const r = await f();
    if (r.ok) await reload();
    else toast(fail, { tone: "danger" });
  };

  const items: CardGridItem[] = list.map((p) => {
    const blocked = p.active
      ? "先把别的版本设为生效"
      : p.refCount
        ? `${p.refCount} 个会话在用`
        : null;
    return {
      id: p.id,
      name: p.name,
      title: p.name,
      ...(p.active
        ? {
            badge: (
              <Chip tone="live" dot>
                生效中
              </Chip>
            ),
          }
        : {}),
      description: p.description || "（没有描述）",
      meta: metaOf(p),
      search: `${p.name}${p.description}`,
      menu: [
        ...(versioned && !p.active
          ? [
              {
                id: "on",
                label: kind === "global-agentsmd" ? "激活" : "设为生效",
                onSelect: () => activate.request(p),
              },
            ]
          : []),
        {
          id: "copy",
          label: "复制",
          onSelect: () => void run(() => copyPreset(p.id), "复制失败"),
        },
        {
          id: "rename",
          label: "重命名…",
          onSelect: () => setRenaming(p),
        },
        {
          id: "del",
          label: "删除",
          tone: "danger" as const,
          separatorBefore: true,
          disabled: blocked !== null,
          ...(blocked ? { hint: blocked } : {}),
          onSelect: () => setDeleting(p),
        },
      ],
    };
  });

  const lead = (
    <>
      {kind === "global-agentsmd" && file.state?.modified && (
        <InlineNotice tone="warn" className="sd-note">
          <span className="sd-note-row">
            <span>
              磁盘上的 <span className="t-mono">{file.state.path}</span>{" "}
              不在任何版本里（有人改过它，或还没有版本写过它）。激活版本会覆盖它，到时先问你。
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void importGlobalAgentsMd(loadToken()).then(
                  async () => {
                    await Promise.all([reload(), file.refresh()]);
                    toast("已把磁盘上的内容存成新版本并设为生效", {
                      tone: "ok",
                    });
                  },
                  () => toast("另存失败，请稍后重试", { tone: "danger" }),
                )
              }
            >
              另存为新版本
            </Button>
          </span>
        </InlineNotice>
      )}
      {LEDE[kind] && <p className="sd-lede t-aux">{LEDE[kind]}</p>}
    </>
  );

  return (
    <>
      <CardGrid
        items={items}
        searchLabel={`搜索${noun}`}
        addLabel={`新建${noun}`}
        onAdd={() => setCreating(true)}
        onOpen={onOpen}
        emptyTitle={`还没有${noun}`}
        lead={lead}
      />
      <PresetNameDialog
        open={creating}
        kind={kind}
        noun={noun}
        editing={null}
        onClose={() => setCreating(false)}
        onDone={(p) => {
          setCreating(false);
          onOpen(p.id);
        }}
      />
      <PresetNameDialog
        open={renaming !== null}
        kind={kind}
        noun={noun}
        editing={renaming}
        onClose={() => setRenaming(null)}
        onDone={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`删除${noun}`}
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const p = deleting;
          setDeleting(null);
          if (p) void run(() => deletePreset(p.id), "删除失败");
        }}
      >
        删除「{deleting?.name}」？它的段与分组会一起删掉，卡片库里的卡片还在。
      </ConfirmDialog>
    </>
  );
}
