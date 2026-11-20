import { useSyncExternalStore } from "react";
import { AlertIcon, CheckIcon, InfoIcon } from "./icons";

export type ToastTone = "info" | "ok" | "warn" | "danger";

export type ToastAction = { label: string; onClick(): void };

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  actions: ToastAction[];
};

export type ToastOptions = {
  tone?: ToastTone;
  // 缺省 3200ms；danger 留得久一点（6000ms），给用户读完错误的时间；0 = 不自动消失（要用户自己点按钮或关掉）
  durationMs?: number;
  // 提示上的按钮：第一个是主操作。点任何一个按钮都会先关掉提示再执行。
  actions?: ToastAction[];
};

// 单例 store：toast() 可在组件外（请求回调、事件处理器）直接调用，由 <ToastHost /> 渲染。
let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const emit = () => {
  for (const l of listeners) l();
};

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}

export function toast(message: string, opts: ToastOptions = {}): number {
  const tone = opts.tone ?? "info";
  const id = ++seq;
  items = [...items, { id, message, tone, actions: opts.actions ?? [] }];
  const ms = opts.durationMs ?? (tone === "danger" ? 6000 : 3200);
  if (ms > 0)
    timers.set(
      id,
      setTimeout(() => dismissToast(id), ms),
    );
  emit();
  return id;
}

// 测试与路由整体切换时用
export function clearToasts() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  items = [];
  emit();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => items;

const ICONS = {
  info: InfoIcon,
  ok: CheckIcon,
  warn: AlertIcon,
  danger: AlertIcon,
} as const;

// 在应用根挂载一次。live region 常驻，内容变化时读屏才会播报。
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className="u-toasts" aria-live="polite">
      {list.map((t) => {
        const Icon = ICONS[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === "danger" ? "alert" : "status"}
            data-tone={t.tone}
            className="u-toast t-aux"
          >
            <Icon size={11} />
            <span>{t.message}</span>
            {t.actions.length > 0 && (
              <span className="u-toast-actions">
                {t.actions.map((a, i) => (
                  <button
                    key={a.label}
                    type="button"
                    className="u-toast-act t-aux"
                    data-primary={i === 0 ? "" : undefined}
                    onClick={() => {
                      dismissToast(t.id);
                      a.onClick();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
