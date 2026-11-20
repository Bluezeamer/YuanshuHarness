import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Modal } from "../../../ui";

/** 页面登记给离开保护的状态：有没有未保存的修改，以及保存 / 放弃的动作。 */
export interface Bound {
  dirty: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

interface Guard {
  bind: (b: Bound | null) => void;
  guard: (go: () => void) => void;
}

// 不在设置壳里（单元测试）时：没有保护，直接放行
const Ctx = createContext<Guard>({ bind: () => {}, guard: (go) => go() });

/** 切换编辑对象、切页签、点设置导航、返回工作区前包一层：有未保存的修改就先问。 */
export const useLeaveGuard = () => useContext(Ctx).guard;

/** 页面登记未保存状态；顺带在有修改时让浏览器刷新 / 关闭也先提醒。 */
export function useBindDirty(b: Bound) {
  const { bind } = useContext(Ctx);
  const latest = useRef(b);
  latest.current = b;
  useEffect(() => {
    bind({
      get dirty() {
        return latest.current.dirty;
      },
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    });
    return () => bind(null);
  }, [bind]);
  useEffect(() => {
    if (!b.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [b.dirty]);
}

/** 设置壳里唯一的一个离开确认：保存 / 放弃修改 / 取消。 */
export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const live = useRef<Bound | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const value = useMemo<Guard>(
    () => ({
      bind: (b) => {
        live.current = b;
      },
      guard: (go) => {
        if (live.current?.dirty) setPending(() => go);
        else go();
      },
    }),
    [],
  );

  const finish = (go: (() => void) | null) => {
    setPending(null);
    go?.();
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title="有未保存的修改"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                live.current?.discard();
                finish(pending);
              }}
            >
              放弃修改
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await live.current?.save();
                setBusy(false);
                // 保存失败：留在原处，失败提示已经弹出，草稿还在
                finish(ok ? pending : null);
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <p className="t-plain">离开前要保存吗？不保存会丢掉这些修改。</p>
      </Modal>
    </Ctx.Provider>
  );
}
