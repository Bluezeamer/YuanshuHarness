// 进度条原语：value 0–100 时是确定进度，null 时是不确定进度（循环滑动）。
// 供文件传输条与对话附件上传卡片复用；样式 .u-progress 在 ui/styles/controls.css。

export interface ProgressBarProps {
  /** 0–100；null 表示进度未知 */
  value: number | null;
  /** 无障碍名称 */
  label: string;
  className?: string;
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  return (
    <div
      className={`u-progress${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      data-indeterminate={value === null || undefined}
    >
      <i style={value === null ? undefined : { width: `${value}%` }} />
    </div>
  );
}
