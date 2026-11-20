import type { DragEvent } from "react";
import type { StudioNode } from "../../../api/studio";
import { Button, ListRow } from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { cardCount } from "./model/eval";
import { moveCard } from "./model/tree";
import type { Dnd } from "./useDnd";

// 左边：段列表（加载顺序）。可以把右边的卡片拖到某一段上，就移过去。
export function SegmentList({
  segs,
  current,
  onCurrent,
  onChange,
  onAdd,
  dnd,
}: {
  segs: StudioNode[];
  current: string;
  onCurrent: (id: string) => void;
  onChange: (next: StudioNode[]) => void;
  onAdd: () => void;
  dnd: Dnd;
}) {
  const droppable = (s: StudioNode) =>
    s.builtin
      ? {}
      : {
          onDragOver: (e: DragEvent) => {
            if (!dnd.drag?.startsWith("c:")) return;
            e.preventDefault();
            dnd.setOver(`s:${s.id}`);
          },
          onDragLeave: () => dnd.setOver(null),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dnd.drag?.startsWith("c:"))
              onChange(
                moveCard(segs, dnd.drag.slice(2), {
                  seg: s.id,
                  group: null,
                  before: null,
                }),
              );
            dnd.setDrag(null);
            dnd.setOver(null);
          },
        };
  return (
    <nav className="sd-chain" aria-label="段">
      <div className="sd-sec-h t-aux">段 · 加载顺序</div>
      {segs.map((s) => (
        <ListRow
          key={s.id}
          size="compact"
          label={s.title}
          sub={`${s.tag === null ? "（头部）" : `<${s.tag}>`}${s.builtin ? " · 系统生成" : ""}${s.channel === "user" ? " · user" : ""}`}
          trail={s.builtin ? undefined : `${cardCount(s)}`}
          current={current === s.id}
          data-drop={dnd.over === `s:${s.id}` || undefined}
          onClick={() => onCurrent(s.id)}
          {...droppable(s)}
        />
      ))}
      <Button size="sm" variant="ghost" icon={<PlusIcon />} onClick={onAdd}>
        新增段
      </Button>
    </nav>
  );
}
