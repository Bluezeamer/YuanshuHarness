import { type DragEvent, type ReactNode, useState } from "react";
import { Button, Chip, InlineNotice, Input, ListRow, Menu } from "../../ui";
import { GripIcon, PlusIcon } from "../../ui/icons";
import { CondButton } from "./StudioCond";
import {
  type Case,
  card,
  evalSegment,
  type Group,
  type Segment,
  type SimModel,
} from "./studioData";
import {
  addGroup,
  moveCard,
  removeCard,
  removeGroup,
  setWhen,
  type Target,
} from "./studioTree";

// 拖放状态：左边的段列表和右边的内容共用，所以放在外面。
export function useDnd() {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return { drag, setDrag, over, setOver };
}
export type Dnd = ReturnType<typeof useDnd>;

// 左边：段列表（加载顺序）。可以把右边的卡片拖到某一段上，就移过去。
export function SegmentList({
  segs,
  current,
  onCurrent,
  onChange,
  dnd,
  onAdd,
  onEdit,
  onRemove,
}: {
  segs: Segment[];
  current: string;
  onCurrent: (id: string) => void;
  onChange: (next: Segment[]) => void;
  dnd: Dnd;
  onAdd?: () => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  return (
    <nav className="gl-chain" aria-label="段">
      <div className="gl-sec-h t-aux">段 · 加载顺序</div>
      {segs.map((s) => {
        const n = s.items.reduce(
          (a, it) => a + (it.kind === "card" ? 1 : it.cards.length),
          0,
        );
        return (
          <ListRow
            key={s.id}
            size="compact"
            label={s.title}
            sub={`${s.tag === null ? "（头部）" : `<${s.tag}>`}${s.lock ? ` · ${s.lock}` : ""}`}
            trail={s.lock ? undefined : `${n}`}
            current={current === s.id}
            data-drop={dnd.over === `s:${s.id}` || undefined}
            onClick={() => onCurrent(s.id)}
            {...(!s.lock && onEdit && onRemove
              ? {
                  actions: (
                    <Menu
                      label={`${s.title} 的操作`}
                      items={[
                        {
                          id: "edit",
                          label: "重命名 / 改标签…",
                          onSelect: () => onEdit(s.id),
                        },
                        {
                          id: "rm",
                          label: "删除这一段",
                          tone: "danger" as const,
                          separatorBefore: true,
                          onSelect: () => onRemove(s.id),
                        },
                      ]}
                    />
                  ),
                }
              : {})}
            {...(s.lock
              ? {}
              : {
                  onDragOver: (e: DragEvent) => {
                    if (!dnd.drag) return;
                    e.preventDefault();
                    dnd.setOver(`s:${s.id}`);
                  },
                  onDragLeave: () => dnd.setOver(null),
                  onDrop: (e: DragEvent) => {
                    e.preventDefault();
                    if (dnd.drag)
                      onChange(
                        moveCard(segs, dnd.drag, {
                          seg: s.id,
                          group: null,
                          before: null,
                        }),
                      );
                    dnd.setDrag(null);
                    dnd.setOver(null);
                  },
                })}
          />
        );
      })}
      <Button size="sm" variant="ghost" icon={<PlusIcon />} onClick={onAdd}>
        新增段
      </Button>
    </nav>
  );
}

export interface BodyProps {
  segs: Segment[];
  seg: Segment;
  onChange: (next: Segment[]) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  /** 点「添加卡片」：弹出卡片选择，目标是这一段或这个分组 */
  onAdd: (seg: string, group: string | null) => void;
  model: SimModel;
  dnd: Dnd;
  /** 只有一段时不画段标题（版本名已经在上面了） */
  bare?: boolean;
  /** 能建分组（按条件选卡）；两份 AGENTS.md 是固定文本，不能 */
  groups?: boolean;
}

// 右边：选中的这一段。卡片直接挂在段下面，或者放进「分组」；分组是一个 switch：按模型选其一。
export function SegmentBody(p: BodyProps) {
  const { dnd, seg } = p;
  const drop = (t: Target) => {
    if (dnd.drag) p.onChange(moveCard(p.segs, dnd.drag, t));
    dnd.setDrag(null);
    dnd.setOver(null);
  };
  const zone = (key: string, group: string | null) => ({
    "data-drop": dnd.over === key || undefined,
    onDragOver: (e: DragEvent) => {
      if (!dnd.drag) return;
      e.preventDefault();
      e.stopPropagation();
      dnd.setOver(key);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) dnd.setOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      drop({ seg: seg.id, group, before: null });
    },
  });

  const moveItems = (id: string) => [
    ...p.segs
      .filter((s) => !s.lock)
      .flatMap((s) => [
        {
          id: `s-${s.id}`,
          label: `移到「${s.title}」`,
          onSelect: () =>
            p.onChange(
              moveCard(p.segs, id, { seg: s.id, group: null, before: null }),
            ),
        },
        ...s.items.flatMap((it) =>
          it.kind === "group"
            ? [
                {
                  id: `g-${it.id}`,
                  label: `移到分组「${it.name}」`,
                  hint: s.title,
                  onSelect: () =>
                    p.onChange(
                      moveCard(p.segs, id, {
                        seg: s.id,
                        group: it.id,
                        before: null,
                      }),
                    ),
                },
              ]
            : [],
        ),
      ]),
    {
      id: "rm",
      label: "移出这份预设",
      tone: "danger" as const,
      separatorBefore: true,
      onSelect: () => p.onChange(removeCard(p.segs, id)),
    },
  ];

  // 一张卡片的行：拖动、点开预览、悬停出现「编辑」和「更多」
  const row = (
    id: string,
    group: string | null,
    state: ReactNode,
    skipped = false,
  ) => {
    const c = card(id);
    return (
      <ListRow
        size="compact"
        draggable
        data-skip={skipped || undefined}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", id);
          dnd.setDrag(id);
        }}
        onDragEnd={() => {
          dnd.setDrag(null);
          dnd.setOver(null);
        }}
        onDragOver={(e) => {
          if (!dnd.drag) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          drop({ seg: seg.id, group, before: id });
        }}
        lead={<GripIcon className="gl-grip" />}
        label={
          <>
            {c.title}
            {c.builtin && <Chip>内置</Chip>}
          </>
        }
        trail={state}
        current={p.selected === id}
        onClick={() => p.onSelect(id)}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => p.onEdit(id)}>
              编辑
            </Button>
            <Menu label={`${c.title} 的更多操作`} items={moveItems(id)} />
          </>
        }
      />
    );
  };

  // 分组里的一张：第一行「如果 ⟨条件⟩」，第二行「则用 ⟨卡片⟩」
  const caseRow = (
    g: Group,
    c: Case,
    i: number,
    winner: string | null | undefined,
  ) => {
    const firstBlank = g.cards.findIndex((x) => x.when === null);
    const first = g.cards.findIndex((x) => x.when !== null) === i;
    const prefix = c.when === null ? "否则" : first ? "如果" : "否则如果";
    const hit = winner === c.id;
    return (
      <div key={c.id} className="gl-case">
        <div className="gl-case-c">
          <span className="gl-case-k t-aux">{prefix}</span>
          <CondButton
            when={c.when}
            prefix={prefix}
            onChange={(w) => p.onChange(setWhen(p.segs, g.id, c.id, w))}
          />
          {firstBlank >= 0 && i > firstBlank && (
            <span className="t-aux">在「否则」后面，用不到</span>
          )}
        </div>
        <div className="gl-case-u">
          <span className="gl-case-k t-aux">则用</span>
          <div className="gl-case-r">
            {row(
              c.id,
              g.id,
              hit ? (
                <Chip tone="live" dot>
                  命中
                </Chip>
              ) : (
                "跳过"
              ),
              !hit,
            )}
          </div>
        </div>
      </div>
    );
  };

  const groupBox = (g: Group, winner: string | null | undefined) => (
    <div key={g.id} className="gl-gbox" {...zone(`g:${g.id}`, g.id)}>
      <div className="gl-gh-t">
        <Chip tone="accent">分组</Chip>
        <span className="t-entry">{g.name}</span>
        <span className="t-aux">按条件选其一 · {g.cards.length} 张</span>
        <span className="gl-sp" />
        {winner === null && g.cards.length > 0 && (
          <span className="t-aux">当前模型下都不成立，什么也不注入</span>
        )}
        <Menu
          label={`分组「${g.name}」的操作`}
          items={[
            {
              id: "del",
              label: "删除分组（卡片留在段里）",
              tone: "danger",
              onSelect: () => p.onChange(removeGroup(p.segs, g.id)),
            },
          ]}
        />
      </div>
      {g.cards.map((c, i) => caseRow(g, c, i, winner))}
      {g.cards.length === 0 && (
        <div className="gl-empty t-aux">
          把卡片拖到这里，或点下面「添加卡片」，再给每张设条件。
        </div>
      )}
      <div className="gl-kids-f">
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon />}
          onClick={() => p.onAdd(seg.id, g.id)}
        >
          添加卡片
        </Button>
        <span className="t-aux gl-help">自上而下，用第一个成立的。</span>
      </div>
    </div>
  );

  const ev = evalSegment(seg, p.model);
  return (
    <section className="gl-seg">
      {!p.bare && (
        <div className="gl-seg-h">
          <span className="t-group">{seg.title}</span>
          {seg.tag !== null && (
            <code className="t-mono">&lt;{seg.tag}&gt;</code>
          )}
          <Chip>{seg.channel}</Chip>
          {seg.lock && <Chip>{seg.lock}</Chip>}
        </div>
      )}
      {seg.lock ? (
        <InlineNotice>这一段由「{seg.lock}」，内容不可编辑。</InlineNotice>
      ) : (
        <div className="gl-list" {...zone(`k:${seg.id}`, null)}>
          {seg.items.map((it) =>
            it.kind === "card" ? (
              <div key={it.id}>
                {row(it.id, null, `${card(it.id).body.length} 字`)}
              </div>
            ) : (
              groupBox(it, ev.winner.get(it.id))
            ),
          )}
          {seg.items.length === 0 && (
            <div className="gl-empty t-aux">这一段还没有卡片</div>
          )}
          <div className="gl-kids-f">
            <Button
              size="sm"
              variant="ghost"
              icon={<PlusIcon />}
              onClick={() => p.onAdd(seg.id, null)}
            >
              添加卡片
            </Button>
            {p.groups !== false && (
              <Button
                size="sm"
                variant="ghost"
                icon={<PlusIcon />}
                onClick={() => p.onChange(addGroup(p.segs, seg.id))}
              >
                新建分组
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
