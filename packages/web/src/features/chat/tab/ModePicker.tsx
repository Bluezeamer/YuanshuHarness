import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, loadToken } from "../../../api/http";
import {
  getSessionModes,
  putSessionModes,
  type SessionModes,
} from "../../../api/sessionModes";
import { Button, ListRow, Popover, toast } from "../../../ui";
import { CheckIcon, ChevronDownIcon } from "../../../ui/icons";

// 模式：按钮显示当前模式，点开从会话的可切换清单里选一个，或选「无模式」退出。
// 切换静默：工具限制立即生效，模型在下一次运行开头收到状态通知。没有可切换的模式时不显示。
export function ModePicker({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<SessionModes | null>(null);

  useEffect(() => {
    let alive = true;
    getSessionModes(loadToken(), sessionId).then(
      (s) => alive && setState(s),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const pick = useCallback(
    async (activeModeId: string | null) => {
      setOpen(false);
      try {
        setState(
          await putSessionModes(loadToken(), sessionId, { activeModeId }),
        );
      } catch (err) {
        const code = err instanceof ApiError ? err.code : null;
        toast(`切换失败：${code ?? "网络不通"}`, { tone: "danger" });
      }
    },
    [sessionId],
  );

  if (!state || state.modes.length === 0) return null;
  const active = state.modes.find((m) => m.id === state.activeModeId);
  const rows = [{ id: null, name: "无模式" }, ...state.modes];
  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="sm"
        data-modepick=""
        aria-expanded={open}
        aria-label="工作模式"
        onClick={() => setOpen(!open)}
      >
        <span data-modename="">{active?.name ?? "无模式"}</span>
        <ChevronDownIcon size={12} />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        placement="top-start"
        label="工作模式"
        width={288}
      >
        <div className="ch-pick">
          <div className="t-group ch-pick-h">工作模式</div>
          {rows.map((m) => {
            const on = m.id === (active?.id ?? null);
            return (
              <ListRow
                key={String(m.id)}
                label={m.name}
                current={on}
                trail={on ? <CheckIcon size={12} /> : undefined}
                data-mode-id={String(m.id)}
                onClick={() => {
                  if (!on) void pick(m.id);
                  else setOpen(false);
                }}
              />
            );
          })}
          <p className="t-aux ch-pick-f">
            立即限制工具；模型在下一轮开头收到模式通知
          </p>
        </div>
      </Popover>
    </>
  );
}
