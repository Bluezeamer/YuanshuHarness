import type { ComponentProps, KeyboardEvent } from "react";
import { useRef } from "react";
import { cx } from "./cx";
import { CloseIcon, SearchIcon } from "./icons";

export type InputProps = ComponentProps<"input"> & {
  /** 路径、模型 id、URL 这类要核对的英文数字内容 */
  mono?: boolean;
  /** 36 高（弹窗里）；缺省 32 */
  large?: boolean;
};

export function Input({
  mono = false,
  large = false,
  className,
  ...rest
}: InputProps) {
  return (
    <input
      data-size={large ? "lg" : undefined}
      className={cx("u-inp", mono ? "t-mono u-mono" : "t-plain", className)}
      {...rest}
    />
  );
}

export type TextareaProps = ComponentProps<"textarea"> & { mono?: boolean };

export function Textarea({ mono = false, className, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={3}
      className={cx(
        "u-textarea",
        mono ? "t-mono u-mono" : "t-plain",
        className,
      )}
      {...rest}
    />
  );
}

export type SliderProps = Omit<
  ComponentProps<"input">,
  "type" | "value" | "onChange"
> & {
  value: number;
  onChange: (value: number) => void;
};

// 滑块用原生 range：方向键/Home/End 与读屏的数值播报都由浏览器给，拖动的连续回调留给使用方。
export function Slider({ value, className, onChange, ...rest }: SliderProps) {
  return (
    <input
      type="range"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cx("u-range", className)}
      {...rest}
    />
  );
}

export type SearchBoxProps = Omit<
  ComponentProps<"input">,
  "type" | "value" | "onChange"
> & {
  value: string;
  onChange: (value: string) => void;
  clearLabel?: string;
};

// 有内容时显示 ×；Esc 先清空，空了才放行给外层（弹层、面板）处理。
export function SearchBox({
  value,
  onChange,
  clearLabel = "清除搜索",
  className,
  onKeyDown,
  ref,
  ...rest
}: SearchBoxProps) {
  const inner = useRef<HTMLInputElement | null>(null);

  const setRefs = (node: HTMLInputElement | null) => {
    inner.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const clear = () => {
    onChange("");
    inner.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.key === "Escape" && value) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  };

  return (
    <div className={cx("u-search", className)}>
      <SearchIcon />
      <input
        ref={setRefs}
        className="t-plain"
        type="text"
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        {...rest}
      />
      {value && (
        <button
          type="button"
          className="u-search-clear"
          aria-label={clearLabel}
          onClick={clear}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
