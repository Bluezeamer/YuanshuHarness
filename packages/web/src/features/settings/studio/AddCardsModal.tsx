import { useState } from "react";
import type { StudioNode } from "../../../api/studio";
import { Button, Card, Chip, ListRow, Modal, SearchBox } from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { usedIds } from "./model/eval";
import { NewCardDialog } from "./NewCardDialog";
import { useStudio } from "./useStudio";

// 添加卡片：弹出一页卡片库，每张都带内容预览，勾几张一起加；库里没有合适的就当场新建。
export function AddCardsModal({
  open,
  onClose,
  segs,
  where,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  segs: StudioNode[];
  /** 「工具与规则 › 本地部署模型」这样的落点文字 */
  where: string;
  onAdd: (ids: string[]) => void;
}) {
  const { groups, reload } = useStudio();
  const [mode, setMode] = useState<"pick" | "new">("pick");
  const [q, setQ] = useState("");
  const [lib, setLib] = useState<string | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const used = usedIds(segs);
  const all = groups.flatMap((g) => g.cards);
  const list = all.filter(
    (c) =>
      (lib === null || c.group === lib) &&
      (q === "" ||
        `${c.title}${c.body}`.toLowerCase().includes(q.toLowerCase())),
  );
  const close = () => {
    setPick([]);
    setMode("pick");
    onClose();
  };
  const toggle = (id: string) =>
    setPick((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );

  if (mode === "new")
    return (
      <NewCardDialog
        open={open}
        onClose={close}
        onBack={() => setMode("pick")}
        onCreated={async (id) => {
          await reload();
          setPick((cur) => [...cur, id]);
          setMode("pick");
        }}
      />
    );

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="添加卡片"
      description={`加到：${where}`}
      footer={
        <>
          <Button
            variant="ghost"
            size="lg"
            icon={<PlusIcon />}
            onClick={() => setMode("new")}
          >
            新建卡片
          </Button>
          <span className="sd-sp" />
          <Button variant="ghost" size="lg" onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={pick.length === 0}
            onClick={() => {
              onAdd(pick);
              close();
            }}
          >
            添加 {pick.length || ""} 张
          </Button>
        </>
      }
    >
      <div className="sd-add">
        <nav className="sd-add-nav" aria-label="卡片分组">
          {[null, ...groups.map((g) => g.group)].map((l) => (
            <ListRow
              key={l ?? "all"}
              size="compact"
              label={l ?? "全部"}
              trail={`${l === null ? all.length : (groups.find((g) => g.group === l)?.cards.length ?? 0)}`}
              current={lib === l}
              onClick={() => setLib(l)}
            />
          ))}
        </nav>
        <div className="sd-add-main">
          <SearchBox
            className="sd-search"
            value={q}
            onChange={setQ}
            placeholder="搜标题或内容"
            aria-label="搜索卡片"
          />
          <div className="sd-tiles">
            {list.map((c) => {
              const on = pick.includes(c.id);
              const isUsed = used.has(c.id);
              return (
                <Card
                  key={c.id}
                  className="sd-tile"
                  data-selected={on || undefined}
                  data-used={isUsed || undefined}
                  title={c.title}
                  badge={
                    isUsed ? (
                      <Chip>已在本预设</Chip>
                    ) : on ? (
                      <Chip tone="accent">已选</Chip>
                    ) : c.builtin ? (
                      <Chip>内置</Chip>
                    ) : undefined
                  }
                  description={
                    <span className="sd-clamp t-code">{c.body}</span>
                  }
                  meta={
                    <span>
                      {c.group} · {c.body.length} 字 · 被 {c.usedBy} 个预设引用
                    </span>
                  }
                  {...(isUsed ? {} : { onOpen: () => toggle(c.id) })}
                />
              );
            })}
            {list.length === 0 && (
              <div className="sd-empty t-aux">没有符合的卡片。</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
