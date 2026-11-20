import type { ComponentProps, ReactNode } from "react";
import { useId } from "react";
import { cx } from "./cx";

// 传给控件的接线：label 的 for、错误/说明的 describedby、无效态
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

type FieldBase = {
  label: ReactNode;
  // 控件是 Input/Select 时用函数形态接线；Segmented 这类复合控件传节点即可，会自动按 group 命名
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
  error?: ReactNode;
};

function useFieldWiring(hasHint: boolean, error: ReactNode) {
  const uid = useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const describedBy =
    [hasHint && hintId, error && errorId].filter(Boolean).join(" ") ||
    undefined;
  const control: FieldControlProps = {
    id: `${uid}-ctl`,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  };
  return { labelId: `${uid}-label`, hintId, errorId, control };
}

// 复合控件没有可 for 的目标，改用 group + labelledby 命名
const groupName = (isFn: boolean, labelId: string) =>
  isFn ? {} : ({ role: "group", "aria-labelledby": labelId } as const);

function renderControl(
  children: FieldBase["children"],
  control: FieldControlProps,
) {
  return typeof children === "function" ? children(control) : children;
}

export type FieldProps = FieldBase &
  Omit<ComponentProps<"div">, "children"> & { hint?: ReactNode };

// 堆叠字段：标签在上，控件在下，用于弹窗与小表单。
export function Field({
  label,
  hint,
  error,
  children,
  className,
  ...rest
}: FieldProps) {
  const { labelId, hintId, errorId, control } = useFieldWiring(!!hint, error);
  const fn = typeof children === "function";
  return (
    <div
      {...groupName(fn, labelId)}
      className={cx("u-field", className)}
      {...rest}
    >
      {fn ? (
        <label className="u-field-label t-entry" htmlFor={control.id}>
          {label}
        </label>
      ) : (
        <span className="u-field-label t-entry" id={labelId}>
          {label}
        </span>
      )}
      {renderControl(children, control)}
      {hint && (
        <span className="u-field-hint t-aux" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="u-field-error t-aux" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export type SettingRowProps = FieldBase &
  Omit<ComponentProps<"div">, "children"> & {
    // 标签下的灰色说明
    description?: ReactNode;
  };

// 设置行：左边名字与说明，右边控件。多个 SettingRow 直接相邻，行间的分隔线由样式负责。
export function SettingRow({
  label,
  description,
  error,
  children,
  className,
  ...rest
}: SettingRowProps) {
  const { labelId, hintId, errorId, control } = useFieldWiring(
    !!description,
    error,
  );
  const fn = typeof children === "function";
  return (
    <div className={cx("u-row", className)} {...rest}>
      <div>
        {fn ? (
          <label className="u-row-label t-entry" htmlFor={control.id}>
            {label}
          </label>
        ) : (
          <div className="u-row-label t-entry" id={labelId}>
            {label}
          </div>
        )}
        {description && (
          <div className="u-row-desc t-aux" id={hintId}>
            {description}
          </div>
        )}
      </div>
      <div className="u-row-ctl" {...groupName(fn, labelId)}>
        {renderControl(children, control)}
        {error && (
          <span className="u-field-error t-aux" id={errorId} role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
