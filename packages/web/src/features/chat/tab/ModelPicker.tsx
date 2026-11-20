import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button, ListRow, Popover, SearchBox, Segmented } from "../../../ui";
import { CheckIcon, ChevronDownIcon } from "../../../ui/icons";
import {
  type CurrentModel,
  fmtCtx,
  groupModels,
  levelLabel,
  levelOnSwitch,
  levelOptions,
  levelsOf,
  nearestLevel,
  specOf,
} from "./models";
import type { ChatConfig } from "./useChatConfig";

export interface PickerProps {
  cfg: ChatConfig;
  current: CurrentModel | null;
}

// 模型与推理强度合成一个按钮「模型名 · 档位」，点开：搜索（吸附顶部）、按供应商分组的模型列表、底部一排档位。
// ↑↓ 循环、Enter 选中、Esc 关闭。换模型保留思考档位意图：新模型支持就沿用，不支持落到声明里最近的一档（同距取低）。
// 改档若此前是跟随 agent 则落成显式指定，否则会被 agent 默认值盖回。
export function ModelPicker({ cfg, current }: PickerProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const groups = groupModels(cfg.providers, q);
  const flat = groups.flatMap((g) => g.rows);
  const spec = current
    ? specOf(cfg.providers, current.provider, current.model)
    : undefined;
  const label = spec?.name ?? current?.model ?? "默认模型";
  const opts = levelOptions(spec);
  const now = current?.reasoning
    ? nearestLevel(
        opts.map((o) => o.level),
        current.reasoning,
      )
    : null;
  const onIdx = flat.findIndex(
    (r) =>
      current &&
      r.provider.id === current.provider &&
      r.spec.id === current.model,
  );

  // 每次打开：清搜索，光标落在当前模型
  const onRef = useRef(onIdx);
  onRef.current = onIdx;
  useEffect(() => {
    if (!open) return;
    setQ("");
    setCursor(Math.max(0, onRef.current));
  }, [open]);

  // 光标行滚进可见区：用 scrollTop 计算，不碰 scrollIntoView
  // biome-ignore lint/correctness/useExhaustiveDependencies: 光标或搜索词变了就要重新对齐可见区
  useEffect(() => {
    const el = list.current;
    const row = el?.querySelector<HTMLElement>("[data-cursor]");
    if (!el || !row) return;
    if (row.offsetTop < el.scrollTop) el.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = row.offsetTop + row.offsetHeight - el.clientHeight;
  }, [cursor, q]);

  const pick = (i: number) => {
    const row = flat[i];
    if (!row) return;
    const same =
      row.provider.id === current?.provider && row.spec.id === current?.model;
    const reasoning = same
      ? nearestLevel(levelsOf(row.spec), current?.reasoning ?? "medium")
      : levelOnSwitch(row.spec, current?.reasoning);
    setOpen(false);
    void cfg.patch({
      model: {
        mode: "explicit",
        provider: row.provider.id,
        model: row.spec.id,
        reasoning,
      },
    });
  };

  const pickLevel = (level: string) => {
    setOpen(false);
    if (!current || level === current.reasoning) return;
    void cfg.patch({
      model: {
        mode: "explicit",
        provider: current.provider,
        model: current.model,
        reasoning: level,
      },
    });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + d + flat.length) % flat.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(cursor);
    }
  };

  const total = groups.length === 0 && q.trim() === "";
  let at = -1;
  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="sm"
        data-modelpick=""
        aria-expanded={open}
        aria-label="切换模型与推理强度"
        onClick={() => setOpen(!open)}
      >
        <span data-modelname="">{label}</span>
        {now && (
          <>
            {" · "}
            <span data-effortname="">{levelLabel(now)}</span>
          </>
        )}
        <ChevronDownIcon size={12} />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="top-end"
        label="选择模型"
        width={360}
      >
        <div className="ch-mdl">
          <div className="ch-mdl-q">
            <SearchBox
              autoFocus
              data-modelq=""
              aria-label="搜索模型"
              placeholder="搜索名称、id、供应商、认证方式"
              value={q}
              onChange={(v) => {
                setQ(v);
                setCursor(0);
              }}
              onKeyDown={onKey}
            />
          </div>
          <div className="ch-mdl-list" ref={list}>
            {groups.map((g) => (
              <div
                key={g.provider.id}
                className="ch-mdl-g"
                data-provider={g.provider.id}
              >
                <div className="ch-mdl-gh">
                  <span className="t-group">{g.provider.name}</span>
                  <span className="t-mono">{g.auth}</span>
                </div>
                {g.rows.map((r) => {
                  at += 1;
                  const i = at;
                  const on =
                    current?.provider === r.provider.id &&
                    current.model === r.spec.id;
                  return (
                    <ListRow
                      key={r.spec.id}
                      size="compact"
                      label={r.spec.name}
                      current={on}
                      trail={
                        <span className="ch-mdl-trail">
                          <span className="t-mono">{fmtCtx(r.spec.ctx)}</span>
                          {on && <CheckIcon size={12} />}
                        </span>
                      }
                      data-pick-model={r.spec.id}
                      data-cursor={i === cursor || undefined}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => pick(i)}
                    />
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && (
              <div className="t-aux ch-mdl-empty" data-mmdlempty="">
                {total ? "没有可选的供应商" : "没有匹配的模型"}
              </div>
            )}
          </div>
          {opts.length > 1 && (
            <div className="ch-mdl-eff">
              <span className="t-group">推理强度</span>
              <Segmented
                size="sm"
                aria-label="推理强度"
                disabled={!current}
                options={opts.map((o) => ({ value: o.level, label: o.label }))}
                value={now ?? ""}
                onChange={pickLevel}
              />
              {opts.find((o) => o.level === now)?.map && (
                <span className="t-mono">
                  {opts.find((o) => o.level === now)?.map}
                </span>
              )}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
