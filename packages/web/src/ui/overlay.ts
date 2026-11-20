import {
  createContext,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export const focusables = (root: HTMLElement | null): HTMLElement[] =>
  root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

// 浮层栈：Esc 只交给最上面一层，嵌套（弹窗里的菜单、弹窗里的弹窗）时不会一起关。
// 嵌套层在同一次提交里挂载时，子层的 effect 先于父层执行，所以不能只看入栈先后：
// 用 React context 记录层深，Esc 选层深最大者，层深相同再取后入栈的。
export const LayerDepth = createContext(0);

type Layer = { dismiss: { current: () => void }; depth: number };
const stack: Layer[] = [];

function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  let top: Layer | undefined;
  for (const layer of stack) {
    if (!top || layer.depth >= top.depth) top = layer;
  }
  if (!top) return;
  e.preventDefault();
  top.dismiss.current();
}

// active 为真期间占用一层；dismiss 总是读取最新的回调，调用方不必 memo。
// 返回本层的深度，调用方要用 <LayerDepth.Provider value={depth}> 包住自己的内容。
export function useDismissLayer(active: boolean, dismiss: () => void): number {
  const depth = useContext(LayerDepth) + 1;
  const ref = useRef(dismiss);
  ref.current = dismiss;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { dismiss: ref, depth };
    if (stack.length === 0) document.addEventListener("keydown", onEscape);
    stack.push(layer);
    return () => {
      stack.splice(stack.indexOf(layer), 1);
      if (stack.length === 0) document.removeEventListener("keydown", onEscape);
    };
  }, [active, depth]);
  return depth;
}

// 打开时记住原焦点，关闭（或卸载）时还回去；initial 缺省聚焦 prefer 区域里第一个可聚焦元素
// （弹窗的内容区，免得焦点落在页头的关闭按钮上），再退回容器内第一个可聚焦元素。
export function useFocusScope(
  active: boolean,
  scope: RefObject<HTMLElement | null>,
  initial?: RefObject<HTMLElement | null>,
  prefer?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const origin = document.activeElement as HTMLElement | null;
    const first =
      initial?.current ??
      focusables(prefer?.current ?? null)[0] ??
      focusables(scope.current)[0];
    (first ?? scope.current)?.focus();
    return () => {
      if (origin?.isConnected) origin.focus();
    };
  }, [active, scope, initial, prefer]);
}

// Tab 在容器内首尾循环，焦点不会漏到弹窗背后。
export function trapTab(e: React.KeyboardEvent, scope: HTMLElement | null) {
  if (e.key !== "Tab") return;
  const items = focusables(scope);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    e.preventDefault();
    return;
  }
  const at = document.activeElement;
  if (e.shiftKey && (at === first || at === scope)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

// 点到 inside 之外时触发；anchor 内的点击交给锚点自己的 onClick（避免“关了又开”）。
export function useOutsidePress(
  active: boolean,
  inside: Array<RefObject<HTMLElement | null>>,
  onOutside: () => void,
) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  const refs = useRef(inside);
  refs.current = inside;
  useEffect(() => {
    if (!active) return;
    const handle = (e: Event) => {
      const t = e.target as Node | null;
      if (refs.current.some((r) => r.current?.contains(t))) return;
      cb.current();
    };
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [active]);
}
