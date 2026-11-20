import { useState } from "react";
import { Button, Card, Chip, FilterChip, Modal, SearchBox } from "../../ui";
import { PlusIcon } from "../../ui/icons";
import { LIB, type Segment, usedIds } from "./studioData";

// 添加卡片：弹出一页卡片库，每张都带内容预览，勾几张一起加。替代原来固定在底部的候选栏。
export function AddCardsModal({
  open,
  onClose,
  segs,
  where,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  segs: Segment[];
  /** 「工具与规则 › 本地部署模型」这样的落点文字 */
  where: string;
  onAdd: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const [lib, setLib] = useState<string | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const used = usedIds(segs);
  const libs = [null, ...new Set(LIB.map((c) => c.lib))];
  const list = LIB.filter(
    (c) =>
      (lib === null || c.lib === lib) &&
      (q === "" ||
        `${c.title}${c.body}`.toLowerCase().includes(q.toLowerCase())),
  );
  const toggle = (id: string) =>
    setPick((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  const done = () => {
    onAdd(pick);
    setPick([]);
  };
  return (
    <Modal
      open={open}
      onClose={() => {
        setPick([]);
        onClose();
      }}
      size="xl"
      title="添加卡片"
      description={`加到：${where}`}
      footer={
        <>
          <Button variant="ghost" size="lg" icon={<PlusIcon />}>
            新建卡片
          </Button>
          <span className="gl-sp" />
          <Button variant="ghost" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={pick.length === 0}
            onClick={done}
          >
            添加 {pick.length || ""} 张
          </Button>
        </>
      }
    >
      <div className="gl-add">
        <div className="gl-cand-bar">
          <SearchBox
            className="gl-search"
            value={q}
            onChange={setQ}
            placeholder="搜标题或内容"
            aria-label="搜索卡片"
          />
          {libs.map((l) => (
            <FilterChip
              key={l ?? "all"}
              pressed={lib === l}
              onClick={() => setLib(l)}
            >
              {l ?? "全部"}
            </FilterChip>
          ))}
        </div>
        <div className="gl-tiles">
          {list.map((c) => {
            const on = pick.includes(c.id);
            const isUsed = used.has(c.id);
            return (
              <Card
                key={c.id}
                className="gl-tile"
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
                description={<span className="gl-clamp t-code">{c.body}</span>}
                meta={
                  <span>
                    {c.lib} · {c.body.length} 字 · 被 {c.usedBy} 个预设引用
                  </span>
                }
                {...(isUsed ? {} : { onOpen: () => toggle(c.id) })}
              />
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
