import { type DragEvent, type ReactNode, useState } from "react";
import type { StudioCase, StudioItem, StudioNode } from "../../../api/studio";
import {
  Button,
  Chip,
  IconButton,
  InlineNotice,
  Input,
  ListRow,
  Menu,
} from "../../../ui";
import { GripIcon, PlusIcon } from "../../../ui/icons";
import { CondButton } from "./CondButton";
import { evalItems, type ModelRef } from "./model/eval";
import {
  addGroup,
  cardKey,
  groupKey,
  moveCard,
  moveGroup,
  removeCard,
  removeGroup,
  renameGroup,
  setWhen,
  shiftItem,
  shiftSegment,
  type Target,
} from "./model/tree";
import type { Dnd } from "./useDnd";
import { useStudio } from "./useStudio";

type Group = Extract<StudioItem, { kind: "group" }>;

export interface BodyProps {
  segs: StudioNode[];
  seg: StudioNode;
  onChange: (next: StudioNode[]) => void;
  selected: string | null;
  onSelect: (cardId: string) => void;
  onEdit: (cardId: string) => void;
  /** 点「添加卡片」：弹出卡片选择，目标是这一段或这个分组 */
  onAdd: (seg: string, group: string | null) => void;
  onEditSegment: (id: string) => void;
  onDeleteSegment: (id: string) => void;
  model: ModelRef | null;
  dnd: Dnd;
  /** 只有一段时不画段标题（版本名已经在上面了） */
  bare?: boolean;
  /** 能不能建分组（按条件选卡）；两份 AGENTS.md 是固定文本，不能。缺省 = 能 */
  groups?: boolean;
}

// 分组名：点一下改，回车或失焦保存，Esc 放弃。
function GroupName({
  name,
  onRename,
}: {
  name: string;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const done = (save: boolean) => {
    setEditing(false);
    if (save && text.trim() !== "" && text.trim() !== name)
      onRename(text.trim());
  };
  if (!editing)
    return (
      <Button
        size="sm"
        variant="ghost"
        className="sd-gname"
        title="点击改名"
        onClick={() => {
          setText(name);
          setEditing(true);
        }}
      >
        {name}
      </Button>
    );
  return (
    <Input
      autoFocus
      aria-label="分组名"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
    />
  );
}

// 右边：选中的这一段。卡片直接挂在段下面，或者放进「分组」；分组是一个 switch：按模型选其一。
export function SegmentBody(p: BodyProps) {
  const { dnd, seg } = p;
  const { cards, providers } = useStudio();
  const drop = (t: Target) => {
    const drag = dnd.drag;
    if (drag?.startsWith("c:")) p.onChange(moveCard(p.segs, drag.slice(2), t));
    else if (drag?.startsWith("g:") && t.group === null)
      p.onChange(moveGroup(p.segs, drag.slice(2), t));
    dnd.setDrag(null);
    dnd.setOver(null);
  };
  // 落点：group 为 null 是段的列表区，否则是这个分组的盒子
  const zone = (key: string, group: string | null, before: string | null) => ({
    "data-drop": dnd.over === key || undefined,
    onDragOver: (e: DragEvent) => {
      if (!dnd.drag || (group !== null && !dnd.drag.startsWith("c:"))) return;
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
      drop({ seg: seg.id, group, before });
    },
  });

  const shift = (group: string | null, key: string, dir: -1 | 1) =>
    p.onChange(shiftItem(p.segs, { seg: seg.id, group, key }, dir));

  const moveItems = (id: string, group: string | null) => [
    { id: "up", label: "上移", onSelect: () => shift(group, cardKey(id), -1) },
    { id: "down", label: "下移", onSelect: () => shift(group, cardKey(id), 1) },
    ...p.segs
      .filter((s) => !s.builtin)
      .flatMap((s) => [
        {
          id: `s-${s.id}`,
          label: `移到「${s.title}」`,
          separatorBefore: s === p.segs.find((x) => !x.builtin),
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
    const c = cards.get(id);
    const title = c?.title ?? "（已不在卡片库里）";
    return (
      <ListRow
        size="compact"
        draggable
        data-skip={skipped || undefined}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", id);
          dnd.setDrag(cardKey(id));
        }}
        onDragEnd={() => {
          dnd.setDrag(null);
          dnd.setOver(null);
        }}
        {...zone(`r:${id}`, group, cardKey(id))}
        lead={<GripIcon className="sd-grip" />}
        label={
          <>
            {title}
            {c?.builtin && <Chip>内置</Chip>}
          </>
        }
        trail={state}
        current={p.selected === id}
        onClick={() => p.onSelect(id)}
        actions={
          <>
            {c && !c.builtin && (
              <Button size="sm" variant="ghost" onClick={() => p.onEdit(id)}>
                编辑
              </Button>
            )}
            <Menu label={`${title} 的更多操作`} items={moveItems(id, group)} />
          </>
        }
      />
    );
  };

  // 分组里的一张：第一行「如果 ⟨条件⟩」，第二行「则用 ⟨卡片⟩」
  const caseRow = (
    g: Group,
    c: StudioCase,
    i: number,
    winner: string | null | undefined,
  ) => {
    const firstBlank = g.cards.findIndex((x) => x.when === null);
    const first = g.cards.findIndex((x) => x.when !== null) === i;
    const prefix = c.when === null ? "否则" : first ? "如果" : "否则如果";
    const hit = winner === c.cardId;
    return (
      <div key={c.cardId} className="sd-case">
        <div className="sd-case-c">
          <span className="sd-case-k t-aux">{prefix}</span>
          <CondButton
            when={c.when}
            prefix={prefix}
            providers={providers}
            onChange={(w) => p.onChange(setWhen(p.segs, g.id, c.cardId, w))}
          />
          {firstBlank >= 0 && i > firstBlank && (
            <span className="t-aux">在「否则」后面，用不到</span>
          )}
        </div>
        <div className="sd-case-u">
          <span className="sd-case-k t-aux">则用</span>
          <div className="sd-case-r">
            {row(
              c.cardId,
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
    <div key={g.id} className="sd-gbox" {...zone(`g:${g.id}`, g.id, null)}>
      <div className="sd-gh-t">
        <IconButton
          label={`拖动分组「${g.name}」`}
          icon={<GripIcon />}
          className="sd-grip"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", g.id);
            dnd.setDrag(groupKey(g.id));
          }}
          onDragEnd={() => {
            dnd.setDrag(null);
            dnd.setOver(null);
          }}
        />
        <Chip tone="accent">分组</Chip>
        <GroupName
          name={g.name}
          onRename={(n) => p.onChange(renameGroup(p.segs, g.id, n))}
        />
        <span className="t-aux">按条件选其一 · {g.cards.length} 张</span>
        <span className="sd-sp" />
        {winner === null && g.cards.length > 0 && (
          <span className="t-aux">当前模型下都不成立，什么也不注入</span>
        )}
        <Menu
          label={`分组「${g.name}」的操作`}
          items={[
            {
              id: "up",
              label: "上移",
              onSelect: () => shift(null, groupKey(g.id), -1),
            },
            {
              id: "down",
              label: "下移",
              onSelect: () => shift(null, groupKey(g.id), 1),
            },
            {
              id: "del",
              label: "删除分组（卡片留在段里）",
              tone: "danger",
              separatorBefore: true,
              onSelect: () => p.onChange(removeGroup(p.segs, g.id)),
            },
          ]}
        />
      </div>
      {g.cards.map((c, i) => caseRow(g, c, i, winner))}
      {g.cards.length === 0 && (
        <div className="sd-empty t-aux">
          把卡片拖到这里，或点下面「添加卡片」，再给每张设条件。
        </div>
      )}
      <div className="sd-kids-f">
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon />}
          onClick={() => p.onAdd(seg.id, g.id)}
        >
          添加卡片
        </Button>
        <span className="t-aux sd-help">自上而下，用第一个成立的。</span>
      </div>
    </div>
  );

  const ev = evalItems(seg.items, p.model);
  const at = p.segs.findIndex((s) => s.id === seg.id);
  return (
    <section className="sd-seg">
      {!p.bare && (
        <div className="sd-seg-h">
          <span className="t-group">{seg.title}</span>
          {seg.tag !== null && (
            <code className="t-mono">&lt;{seg.tag}&gt;</code>
          )}
          <Chip>{seg.channel}</Chip>
          {seg.builtin && <Chip>系统生成</Chip>}
          <span className="sd-sp" />
          <Menu
            label={`段「${seg.title}」的操作`}
            items={[
              {
                id: "edit",
                label: "修改名称与段名…",
                onSelect: () => p.onEditSegment(seg.id),
              },
              {
                id: "up",
                label: "上移（提前加载）",
                disabled: at <= 0 || p.segs[at - 1]?.channel !== seg.channel,
                onSelect: () => p.onChange(shiftSegment(p.segs, seg.id, -1)),
              },
              {
                id: "down",
                label: "下移（延后加载）",
                disabled:
                  at >= p.segs.length - 1 ||
                  p.segs[at + 1]?.channel !== seg.channel,
                onSelect: () => p.onChange(shiftSegment(p.segs, seg.id, 1)),
              },
              {
                id: "del",
                label: "删除这一段",
                tone: "danger",
                separatorBefore: true,
                disabled: seg.builtin || seg.tag === null,
                onSelect: () => p.onDeleteSegment(seg.id),
              },
            ]}
          />
        </div>
      )}
      {seg.builtin ? (
        <InlineNotice>这一段由系统生成，内容不可编辑。</InlineNotice>
      ) : (
        <div className="sd-list" {...zone(`k:${seg.id}`, null, null)}>
          {seg.items.map((it) =>
            it.kind === "card" ? (
              <div key={it.cardId}>
                {row(
                  it.cardId,
                  null,
                  `${cards.get(it.cardId)?.body.length ?? 0} 字`,
                )}
              </div>
            ) : (
              groupBox(it, ev.winner.get(it.id))
            ),
          )}
          {seg.items.length === 0 && (
            <div className="sd-empty t-aux">这一段还没有卡片</div>
          )}
          <div className="sd-kids-f">
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
