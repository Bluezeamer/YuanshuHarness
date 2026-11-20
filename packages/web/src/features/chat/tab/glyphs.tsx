// 对话标签专用的小图标（ui/icons 没有的几枚），与 ui/icons 同一套画法：16 格、1.6 线宽、currentColor。
import type { ReactNode, SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function make(body: ReactNode) {
  return ({ size = 12, ...rest }: Props) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {body}
    </svg>
  );
}

export const ClipGlyph = make(
  <path d="M10.5 5.5 6 10a1.4 1.4 0 0 0 2 2l5-5a3 3 0 0 0-4.2-4.2L4 8a4.4 4.4 0 0 0 6.2 6.2" />,
);
export const ClockGlyph = make(
  <>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.2" />
  </>,
);
export const StackGlyph = make(
  <path d="M8 2.5 2.5 5.5 8 8.5l5.5-3zM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3" />,
);
export const TypeGlyph = make(<path d="M3 4.5V3.5h10v1M8 3.5v9M6 12.5h4" />);
