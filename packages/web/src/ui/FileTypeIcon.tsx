import type { SVGProps } from "react";
import { ICONS } from "./file-icons/file-icons.generated";
import { dirIconName, fileIconName } from "./file-icons/resolve";

export type FileTypeIconProps = Omit<
  SVGProps<SVGSVGElement>,
  "children" | "name"
> & {
  /** 文件或目录的名字（不是路径） */
  name: string;
  dir?: boolean;
  /** 目录是否展开 */
  open?: boolean;
  size?: number;
};

// 文件类型图标：按名字挑图标，彩色（色板在 tokens.css 的 --ci-*）。
// 图标集由 scripts/gen-file-icons.mjs 生成，换一套图标只动那个脚本与 mapping.json，组件接口不变。
export function FileTypeIcon({
  name,
  dir = false,
  open = false,
  size = 16,
  ...rest
}: FileTypeIconProps) {
  const icon = dir ? dirIconName(name, open) : fileIconName(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      data-icon={icon}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 图标内容是构建时生成的常量，不含用户输入
      dangerouslySetInnerHTML={{ __html: ICONS[icon] ?? "" }}
      {...rest}
    />
  );
}
