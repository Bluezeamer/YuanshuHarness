import { useState } from "react";
import { ApiError } from "../../../api/http";
import {
  copyCard,
  createCardGroup,
  deleteCard,
  deleteCardGroup,
  type StudioCard,
} from "../../../api/studio";
import {
  Chip,
  ConfirmDialog,
  Field,
  FormDialog,
  Input,
  toast,
} from "../../../ui";
import { CardGrid, type CardGridItem } from "../frame/CardGrid";
import { SplitPane } from "../frame/layout";
import { RailList } from "../frame/RailList";
import { CardEditorModal } from "./CardEditorModal";
import { NewCardDialog } from "./NewCardDialog";
import { useStudio } from "./useStudio";

const ALL = "";

// 卡片库：提示词的来源，所有预设都从这里取片段。左边是分组（可新建；空分组可删），右边是这个分组里的卡片；
// 点卡片在悬浮窗里看与改（也能改它所在的分组）。内置卡片只读，可复制后编辑；被预设引用的卡片不能删。

// 新建分组：只要一个名字
function NewGroupDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      await createCardGroup(name.trim());
      onDone(name.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "exists"
          ? "已经有这个分组了"
          : "新建失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      size="sm"
      title="新建分组"
      description="分组只用来归类卡片，不影响提示词怎么拼"
      confirmLabel="新建"
      canSubmit={name.trim() !== ""}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field label="分组名">
        {(c) => (
          <Input
            {...c}
            autoFocus
            maxLength={50}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}
export function CardLibrary() {
  const { groups, cards, reload } = useStudio();
  const [lib, setLib] = useState(ALL);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [deleting, setDeleting] = useState<StudioCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = groups.flatMap((g) => g.cards);
  const shown = lib === ALL ? all : all.filter((c) => c.group === lib);

  const copy = async (c: StudioCard) => {
    const r = await copyCard(c.id);
    if (r.ok) {
      await reload();
      toast("已复制一份", { tone: "ok" });
    } else toast("复制失败", { tone: "danger" });
  };

  const removeGroup = async (name: string) => {
    try {
      await deleteCardGroup(name);
      await reload();
      if (lib === name) setLib(ALL);
      toast(`已删除分组「${name}」`, { tone: "ok" });
    } catch {
      toast("删除失败，请稍后重试", { tone: "danger" });
    }
  };

  const items: CardGridItem[] = shown.map((c) => ({
    id: c.id,
    name: c.title,
    title: c.title,
    ...(c.builtin ? { badge: <Chip>内置</Chip> } : {}),
    description: <span className="sd-clamp t-code">{c.body}</span>,
    meta: (
      <span>
        {c.group} · {c.body.length} 字 · 被 {c.usedBy} 个预设引用
      </span>
    ),
    search: `${c.title}${c.body}`.toLowerCase(),
    menu: [
      { id: "copy", label: "复制一份", onSelect: () => void copy(c) },
      {
        id: "del",
        label: "删除",
        tone: "danger" as const,
        separatorBefore: true,
        disabled: c.builtin || c.usedBy > 0,
        ...(c.builtin
          ? { hint: "内置" }
          : c.usedBy > 0
            ? { hint: `${c.usedBy} 个预设在用` }
            : {}),
        onSelect: () => {
          setError(null);
          setDeleting(c);
        },
      },
    ],
  }));

  return (
    <>
      <SplitPane
        rail={
          <RailList
            title="卡片库"
            total={all.length}
            sections={[
              {
                key: "groups",
                items: [
                  { id: ALL, label: "全部", trail: `${all.length}` },
                  ...groups.map((g) => ({
                    id: g.group,
                    label: g.group,
                    trail: `${g.cards.length}`,
                    menu: [
                      {
                        id: "del",
                        label: "删除分组",
                        tone: "danger" as const,
                        disabled: g.cards.length > 0,
                        ...(g.cards.length > 0
                          ? { hint: `还有 ${g.cards.length} 张卡片` }
                          : {}),
                        onSelect: () => void removeGroup(g.group),
                      },
                    ],
                  })),
                ],
              },
            ]}
            sel={lib}
            onSel={setLib}
            addLabel="新建分组"
            onAdd={() => setNewGroup(true)}
            noneText="还没有卡片"
          />
        }
      >
        <div className="st-col">
          <CardGrid
            key={lib}
            items={items}
            searchLabel="搜标题或内容"
            addLabel="新建卡片"
            onAdd={() => setCreating(true)}
            onOpen={setEditing}
            emptyTitle={lib === ALL ? "还没有卡片" : "这个分组里没有卡片"}
          />
        </div>
      </SplitPane>
      <CardEditorModal
        card={editing ? (cards.get(editing) ?? null) : null}
        onClose={() => setEditing(null)}
      />
      {newGroup && (
        <NewGroupDialog
          open
          onClose={() => setNewGroup(false)}
          onDone={async (name) => {
            await reload();
            setNewGroup(false);
            setLib(name);
          }}
        />
      )}
      {creating && (
        <NewCardDialog
          open
          {...(lib !== ALL ? { defaultGroup: lib } : {})}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            await reload();
            setCreating(false);
            setEditing(id);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="删除卡片"
        confirmLabel="删除"
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void deleteCard(deleting.id).then(async (r) => {
            if (!r.ok) return setError("删除失败，可能刚刚被预设引用了");
            setDeleting(null);
            await reload();
          });
        }}
      >
        删除「{deleting?.title}」？删除后不能恢复。
      </ConfirmDialog>
    </>
  );
}
