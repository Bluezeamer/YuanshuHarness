import { useEffect, useRef, useState } from "react";
import { TIER_LABEL, tierChoices } from "../../../api/defaults";
import { Button, ListRow, Popover } from "../../../ui";
import { CheckIcon, ChevronDownIcon } from "../../../ui/icons";
import type { ChatConfig } from "./useChatConfig";

// 审批：按钮显示本会话生效的审批档，点开可切（含「跟随全局」，X02）。运行时每次工具调用都重读，立即生效。
export function PermPicker({ cfg }: { cfg: ChatConfig }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { reloadDefaults } = cfg;
  // 全局默认可能在设置页改过：每次打开都重读，「跟随全局 · X」写的才是现值。
  useEffect(() => {
    if (open) reloadDefaults();
  }, [open, reloadDefaults]);
  const override = cfg.config?.permissionTier ?? null;
  const global = cfg.defaults?.permissionTier ?? "rules";
  const effective = override ?? global;
  const source = override === null ? "跟随全局" : "本会话覆盖";
  const choices = tierChoices(global, cfg.defaults?.reviewModel != null);
  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="sm"
        data-permpick=""
        data-override={override === null ? undefined : ""}
        aria-expanded={open}
        aria-label={`审批档位：${TIER_LABEL[effective]}（${source}）`}
        onClick={() => setOpen(!open)}
      >
        <span data-permlead="">审批 · </span>
        <span data-permname="">{TIER_LABEL[effective]}</span>
        <ChevronDownIcon size={12} />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="top-start"
        label="审批档位"
        width={372}
      >
        <div className="ch-pick">
          <div className="t-group ch-pick-h">
            审批档位 · {TIER_LABEL[effective]}（{source}）
          </div>
          {choices.map((c) => {
            const on = c.value === override;
            return (
              <ListRow
                key={String(c.value)}
                label={c.label}
                sub={c.hint}
                current={on}
                trail={on ? <CheckIcon size={12} /> : undefined}
                data-perm-tier={String(c.value)}
                {...(c.disabled ? { "aria-disabled": true } : {})}
                onClick={() => {
                  if (c.disabled) return;
                  if (!on) void cfg.patch({ permissionTier: c.value });
                  setOpen(false);
                }}
              />
            );
          })}
          <p className="t-aux ch-pick-f">
            档位立即生效；逐工具细则在「设置 · 工具」里改
          </p>
        </div>
      </Popover>
    </>
  );
}
