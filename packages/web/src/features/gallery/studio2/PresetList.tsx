import { useState } from "react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Empty,
  InlineNotice,
  Menu,
  SearchBox,
  toast,
} from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { NameDialog, type useActivate } from "./Dialogs";
import { cardsOf, type Kind, NOUN, type Preset, type Store } from "./data";

const SEARCH: Record<Kind, string> = {
  gmd: "搜索版本",
  pmd: "搜索模板",
  extra: "搜索版本",
  agent: "搜索 Agent",
  mode: "搜索模式",
};

const metaOf = (p: Preset) => {
  const n = cardsOf(p.segs);
  if (p.kind === "agent")
    return (
      <>
        <span>{n} 张卡片</span>
        <span>{p.refs ? `${p.refs} 个会话在用` : "未被引用"}</span>
      </>
    );
  if (p.kind === "extra")
    return (
      <>
        <span>{n} 张卡片</span>
        <span>按模型路由</span>
      </>
    );
  if (p.kind === "pmd")
    return (
      <>
        <span>{n} 张卡片</span>
        <span>创建工作区时可选</span>
      </>
    );
  return <span>{n} 张卡片</span>;
};

// 列表页：页签下面是搜索 + 新建，再下面是卡片网格；点卡片进编辑页。
export function PresetList({
  kind,
  store,
  onOpen,
  activate,
}: {
  kind: Kind;
  store: Store;
  onOpen: (id: string) => void;
  activate: ReturnType<typeof useActivate>;
}) {
  const noun = NOUN[kind];
  const [q, setQ] = useState("");
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState<Preset | null>(null);
  const list = store.list.filter((p) => p.kind === kind);
  const shown = list.filter((p) => `${p.name}${p.desc}`.includes(q));
  const versioned = kind === "gmd" || kind === "extra";

  return (
    <>
      {kind === "gmd" && store.disk && (
        <InlineNotice tone="warn" className="sp-note">
          <span className="sp-note-row">
            <span>
              磁盘上的 <span className="t-mono">~/.ys/AGENTS.md</span>{" "}
              比生效版本新（有人改过它）。激活别的版本会覆盖它，到时先问你。
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                store.add("gmd", "从磁盘导入", "磁盘上手改过的内容", [
                  {
                    id: "body",
                    title: "正文",
                    tag: null,
                    channel: "system",
                    items: [{ kind: "card", id: "agentsmd" }],
                  },
                ]);
                store.setDisk(false);
                toast("已把磁盘上的内容存成新版本", { tone: "ok" });
              }}
            >
              另存为新版本
            </Button>
          </span>
        </InlineNotice>
      )}
      {kind === "gmd" && (
        <p className="sp-lede t-aux">
          全局约定：同一时间只有一个版本生效，激活时写入{" "}
          <span className="t-mono">~/.ys/AGENTS.md</span>，对所有会话生效。
        </p>
      )}
      {kind === "pmd" && (
        <p className="sp-lede t-aux">
          这里只存模板：创建工作区时选一个作为起点，写进主目录的{" "}
          <span className="t-mono">AGENTS.md</span>
          ，之后归项目自己，这里不再管。
        </p>
      )}
      {kind === "extra" && (
        <p className="sp-lede t-aux">
          不写任何文件：每次建会话按当时的模型选出内容，注入对话开头，排在全局
          AGENTS.md 之后、项目 AGENTS.md 之前。同一时间只有一个版本生效。
        </p>
      )}
      <div className="sp-bar">
        <SearchBox
          aria-label={SEARCH[kind]}
          placeholder={SEARCH[kind]}
          className="sp-search"
          value={q}
          onChange={setQ}
        />
        <Button icon={<PlusIcon size={14} />} onClick={() => setNaming(true)}>
          新建{noun}
        </Button>
      </div>
      {shown.length === 0 && (
        <Empty
          title={list.length === 0 ? `还没有${noun}` : `没有符合的${noun}`}
        />
      )}
      <div className="sp-grid">
        {shown.map((p) => (
          <Card
            key={p.id}
            title={p.name}
            {...(p.active
              ? {
                  badge: (
                    <Chip tone="live" dot>
                      生效中
                    </Chip>
                  ),
                }
              : {})}
            description={p.desc || "（没有描述）"}
            meta={metaOf(p)}
            onOpen={() => onOpen(p.id)}
            actions={
              <Menu
                label={`${p.name} 的操作`}
                items={[
                  ...(versioned && !p.active
                    ? [
                        {
                          id: "on",
                          label: kind === "gmd" ? "激活" : "设为生效",
                          onSelect: () => activate.request(p),
                        },
                      ]
                    : []),
                  {
                    id: "copy",
                    label: "复制",
                    onSelect: () => {
                      store.copy(p.id);
                      toast(`已复制「${p.name}」`, { tone: "ok" });
                    },
                  },
                  {
                    id: "del",
                    label: "删除",
                    tone: "danger" as const,
                    separatorBefore: true,
                    disabled: Boolean(p.active || p.refs),
                    ...(p.active
                      ? { hint: "先激活别的版本" }
                      : p.refs
                        ? { hint: `${p.refs} 个会话在用` }
                        : {}),
                    onSelect: () => setDeleting(p),
                  },
                ]}
              />
            }
          />
        ))}
      </div>
      {naming && (
        <NameDialog
          open
          title={`新建${noun}`}
          initial={{ name: "", desc: "" }}
          onClose={() => setNaming(false)}
          onSubmit={(v) => {
            setNaming(false);
            onOpen(store.add(kind, v.name, v.desc));
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`删除${noun}`}
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) store.remove(deleting.id);
          setDeleting(null);
          toast("已删除", { tone: "ok" });
        }}
      >
        删除「{deleting?.name}」？它的段与分组会一起删掉，卡片库里的卡片还在。
      </ConfirmDialog>
    </>
  );
}
