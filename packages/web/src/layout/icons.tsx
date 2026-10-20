import type { ReactNode } from "react";

// 装饰性图标：按钮自己有 aria-label，图标对读屏隐藏。
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// 左右并排：外框加一条竖线。
export const SplitRightIcon = () => (
  <Svg>
    <rect x="1.5" y="2" width="11" height="10" />
    <path d="M7 2v10" />
  </Svg>
);

// 上下叠放：外框加一条横线。
export const SplitDownIcon = () => (
  <Svg>
    <rect x="1.5" y="2" width="11" height="10" />
    <path d="M1.5 7h11" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M3 3l8 8M11 3l-8 8" />
  </Svg>
);

export const NavIcon = () => (
  <Svg>
    <path d="M2 3.5h10M2 7h6M2 10.5h8" />
  </Svg>
);
