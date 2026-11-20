// 文件标签专用图标。
// 不自绘 svg：统一取 lucide-react（MIT、按需 tree-shake、图标语义与业界一致），
// 这里只做一层薄封装，把尺寸与线宽对齐到仓库既有的 16 格描线观感。
// 文件类型图标（按名字挑的彩色图标）在 ui/FileTypeIcon，这里只留工具栏与拖拽条的通用图标。

import type { LucideIcon } from "lucide-react";
import {
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  File,
  Folder,
  GitBranch,
  RotateCw,
} from "lucide-react";
import type { IconProps } from "../../../../ui/icons";

/** lucide 是 24 格、默认线宽 2；缩到 13px 偏粗，给 1.9 才接近既有 16 格 1.6 的观感 */
const make =
  (Icon: LucideIcon) =>
  ({ size = 13, ...rest }: IconProps) => (
    <Icon size={size} strokeWidth={1.9} aria-hidden="true" {...rest} />
  );

export const FolderIcon = make(Folder);
export const FileIcon = make(File);
export const UpIcon = make(ArrowUp);
export const RefreshIcon = make(RotateCw);
export const BranchIcon = make(GitBranch);
export const EyeIcon = make(Eye);
export const EyeOffIcon = make(EyeOff);
export const DownloadIcon = make(Download);
