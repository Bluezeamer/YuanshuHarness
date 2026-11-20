// 命令面板（Ctrl+K）：搜索 + 分组列表。↑↓ 移光标，Enter 执行，Esc 关闭。
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Input, Kbd, Modal } from "../../ui";
import {
  type CommandKind,
  filterCommands,
  groupCommands,
  KIND_LABEL,
  type PaletteCommand,
} from "./commands";

export interface PaletteProps {
  open: boolean;
  onClose(): void;
  commands: readonly PaletteCommand[];
  /** 排在最前的那一类（总览入口让「工作区」打头） */
  lead?: CommandKind;
}

export function Palette({ open, onClose, commands, lead }: PaletteProps) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();

  const shown = useMemo(() => filterCommands(commands, q), [commands, q]);
  const groups = useMemo(() => groupCommands(shown, lead), [shown, lead]);
  // 光标按分组后的显示顺序走，所以拍平的是分组后的列表
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // 每次打开清空查询；关闭时不保留，避免下次打开看到旧过滤
  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
    }
  }, [open]);
  // 过滤后光标回到顶部
  // biome-ignore lint/correctness/useExhaustiveDependencies: q 变化即重置
  useEffect(() => setCursor(0), [q]);

  // 光标行滚入可视区；用 scrollTop 计算而不是 scrollIntoView（避免带动外层滚动）
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>(`[data-i="${cursor}"]`);
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (
      row.offsetTop + row.offsetHeight >
      box.scrollTop + box.clientHeight
    )
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [cursor]);

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setCursor((i) => (i + d + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[cursor]);
    }
  };

  let index = -1;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="命令面板"
      description="搜索操作、设置页、工作区与会话"
      size="md"
      initialFocus={input}
    >
      <div className="sh-pal">
        <Input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-activedescendant={
            flat[cursor] ? `${uid}-${flat[cursor].id}` : undefined
          }
          aria-label="搜索命令"
          placeholder="输入以搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div
          ref={list}
          id={`${uid}-list`}
          className="sh-pal-list"
          role="listbox"
          aria-label="命令"
        >
          {flat.length === 0 && (
            <p className="sh-pal-empty t-aux">没有匹配的命令</p>
          )}
          {groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: listbox 里的分组就是 role=group；fieldset 带默认边框与最小宽度，不适合列表分组
            <div key={g.kind} role="group" aria-label={KIND_LABEL[g.kind]}>
              <div className="sh-pal-k t-group" aria-hidden="true">
                {KIND_LABEL[g.kind]}
              </div>
              {g.items.map((c) => {
                index += 1;
                const i = index;
                return (
                  <Button
                    key={c.id}
                    id={`${uid}-${c.id}`}
                    variant="ghost"
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === cursor}
                    data-i={i}
                    className="sh-pal-row"
                    onMouseMove={() => i !== cursor && setCursor(i)}
                    onClick={() => run(c)}
                  >
                    <span className="sh-pal-l">{c.label}</span>
                    {c.note && (
                      <span className="sh-pal-note t-aux">{c.note}</span>
                    )}
                    {c.key && <Kbd>{c.key}</Kbd>}
                  </Button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
