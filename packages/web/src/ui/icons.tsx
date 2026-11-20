import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
};

// 装饰性图标：默认对读屏隐藏，名字由外层按钮的 aria-label 提供。
function make(name: string, body: ReactNode) {
  const Icon = ({ size = 14, ...rest }: IconProps) => (
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
  Icon.displayName = name;
  return Icon;
}

export const SearchIcon = make(
  "SearchIcon",
  <>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 14 14" />
  </>,
);
export const PlusIcon = make("PlusIcon", <path d="M8 3v10M3 8h10" />);
export const PlayIcon = make("PlayIcon", <path d="M5 3.2v9.6L12.6 8z" />);
export const PauseIcon = make("PauseIcon", <path d="M5.5 3.5v9M10.5 3.5v9" />);
export const HistoryIcon = make(
  "HistoryIcon",
  <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3M8 5.5V8l1.8 1.2" />,
);
export const CheckIcon = make("CheckIcon", <path d="M3 8.5 6.5 12 13 4.5" />);
export const ArrowUpIcon = make(
  "ArrowUpIcon",
  <path d="M8 13V3M4 7l4-4 4 4" />,
);
export const StopIcon = make(
  "StopIcon",
  <rect x="4" y="4" width="8" height="8" rx="1.5" />,
);
export const FolderIcon = make(
  "FolderIcon",
  <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />,
);
/** 图钉：固定 */
export const PinIcon = make(
  "PinIcon",
  <path d="M9.8 2.6 13.4 6.2 11.6 7 9.6 9l.3 2.6-.9.9L6.4 9.9 3 13.3M6.2 6.6l-.4-.3-1 .9 3.9 3.9" />,
);
/** 全部折叠：两个箭头朝中间 */
/** 归档：盒子 */
export const ArchiveIcon = make(
  "ArchiveIcon",
  <path d="M2.5 3.5h11v3h-11zM3.5 6.5V12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.5M6.5 9h3" />,
);
export const CollapseAllIcon = make(
  "CollapseAllIcon",
  <path d="M3 8h10M5.5 3.5 8 6l2.5-2.5M5.5 12.5 8 10l2.5 2.5" />,
);
/** 全部展开：两个箭头朝外（与全部折叠相反） */
export const ExpandAllIcon = make(
  "ExpandAllIcon",
  <path d="M3 8h10M5.5 6 8 3.5 10.5 6M5.5 10 8 12.5 10.5 10" />,
);
/** 侧栏开关：一个窗口里靠左的一栏 */
export const SidebarIcon = make(
  "SidebarIcon",
  <>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M6.5 3v10" />
  </>,
);
/** 画布：两块卡片加一条连线（与画布标签的图标一致） */
export const CanvasIcon = make(
  "CanvasIcon",
  <path d="M2.5 3.5h5v4h-5zM9 9h4.5v4H9zM7.5 5.5H11V9" />,
);
/** 新建画布：画布图标的一张卡片加一条线，右下角换成加号 */
export const CanvasAddIcon = make(
  "CanvasAddIcon",
  <path d="M2.5 3.5h5v4h-5zM7.5 5.5H11V8M11.5 10v4M9.5 12h4" />,
);
/** 新建笔记：文件图标右下角带加号 */
export const NoteAddIcon = make(
  "NoteAddIcon",
  <>
    <path d="M8 14H4.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h4.8l3.2 3.2V8" />
    <path d="M9 2v3.5h3.5M12 10v4M10 12h4" />
  </>,
);
export const FileIcon = make(
  "FileIcon",
  <>
    <path d="M4.5 2h4.8l3.2 3.2V13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
    <path d="M9 2v3.5h3.5" />
  </>,
);
export const TerminalIcon = make(
  "TerminalIcon",
  <path d="M3 4.5 6.5 8 3 11.5M8 12h5" />,
);
export const ChatIcon = make(
  "ChatIcon",
  <path d="M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7.5L4.5 13.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />,
);
export const RefreshIcon = make(
  "RefreshIcon",
  <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />,
);
export const RotateCwIcon = make(
  "RotateCwIcon",
  <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />,
);
export const RotateCcwIcon = make(
  "RotateCcwIcon",
  <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" />,
);
export const MinusIcon = make("MinusIcon", <path d="M3.5 8h9" />);
export const CloseIcon = make("CloseIcon", <path d="M4 4l8 8M12 4l-8 8" />);
export const BackIcon = make("BackIcon", <path d="M13 8H3M7 4 3 8l4 4" />);
export const ForwardIcon = make(
  "ForwardIcon",
  <path d="M3 8h10M9 4l4 4-4 4" />,
);
export const ChevronRightIcon = make(
  "ChevronRightIcon",
  <path d="M6 4l4 4-4 4" />,
);
export const ChevronDownIcon = make(
  "ChevronDownIcon",
  <path d="M4 6l4 4 4-4" />,
);
export const CopyIcon = make(
  "CopyIcon",
  <>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </>,
);
export const TrashIcon = make(
  "TrashIcon",
  <path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.6 8h4.8l.6-8" />,
);
export const AlertIcon = make(
  "AlertIcon",
  <>
    <path d="M8 3.2 13.5 13h-11z" />
    <path d="M8 6.6v3M8 11.6v.4" />
  </>,
);
export const InfoIcon = make(
  "InfoIcon",
  <>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 7.4V11M8 5.2v.2" />
  </>,
);
export const MoreIcon = make(
  "MoreIcon",
  <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />,
);
export const SpinnerIcon = make(
  "SpinnerIcon",
  <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" opacity=".9" />,
);
export const SlidersIcon = make(
  "SlidersIcon",
  <>
    <path d="M3 5h4.5M11.5 5H13M3 11h2M9.5 11H13" />
    <circle cx="9.5" cy="5" r="1.7" />
    <circle cx="7.5" cy="11" r="1.7" />
  </>,
);
export const GripIcon = make(
  "GripIcon",
  <path
    d="M6 4h.01M6 8h.01M6 12h.01M10 4h.01M10 8h.01M10 12h.01"
    strokeWidth={2}
  />,
);

// 设置导航与详情头
export const ProvidersIcon = make(
  "ProvidersIcon",
  <>
    <rect x="2.5" y="3" width="11" height="4" rx="1.2" />
    <rect x="2.5" y="9" width="11" height="4" rx="1.2" />
    <path d="M5 5h.01M5 11h.01" strokeWidth={2.2} />
  </>,
);

export const RemoteIcon = make(
  "RemoteIcon",
  <>
    <rect x="2" y="3" width="12" height="8" rx="1.4" />
    <path d="M5.5 14h5M8 11v3" />
  </>,
);

export const VariablesIcon = make(
  "VariablesIcon",
  <>
    <rect x="3" y="7" width="10" height="6.5" rx="1.4" />
    <path d="M5.2 7V5.4a2.8 2.8 0 0 1 5.6 0V7" />
  </>,
);

export const ToolsIcon = make(
  "ToolsIcon",
  <path d="M10.2 2.6a3.2 3.2 0 0 0-2.9 4.3L2.8 11.4a1.4 1.4 0 0 0 2 2l4.5-4.5a3.2 3.2 0 0 0 4.3-2.9l-2 1.5-1.6-.4-.4-1.6z" />,
);

export const BlocksIcon = make(
  "BlocksIcon",
  <>
    <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1" />
    <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1" />
    <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1" />
    <path d="M11.2 9v4M9.2 11h4" />
  </>,
);

// 插头：pi 扩展
export const PlugIcon = make(
  "PlugIcon",
  <>
    <path d="M6 2.5v3M10 2.5v3" />
    <path d="M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0z" />
    <path d="M8 11.2v2.3" />
  </>,
);

export const DefaultsIcon = make(
  "DefaultsIcon",
  <>
    <path d="M2.5 5h6M12.5 5h1M2.5 11h2M8.5 11h5" />
    <circle cx="10.5" cy="5" r="1.7" />
    <circle cx="6.5" cy="11" r="1.7" />
  </>,
);

// 浏览器标签
export const LockIcon = make(
  "LockIcon",
  <>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
  </>,
);
export const KeyIcon = make(
  "KeyIcon",
  <>
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="M7.3 8.7 13 3M10.5 5.5 12 7M12 4l1.5 1.5" />
  </>,
);
export const GlobeIcon = make(
  "GlobeIcon",
  <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />,
);
export const ExternalIcon = make(
  "ExternalIcon",
  <path d="M9 3h4v4M13 3 7.5 8.5M12 9v3.5H3.5V4H7" />,
);
export const PhoneIcon = make(
  "PhoneIcon",
  <>
    <rect x="4.5" y="1.8" width="7" height="12.4" rx="1.6" />
    <path d="M7 12h2" />
  </>,
);
