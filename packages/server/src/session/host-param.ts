// 模型可见的 host 参数声明只在这里写一份：六个文件工具、transfer_files 两端与 browser_upload 共用。

/** 文件工具、transfer_files 两端与 browser_upload 共用的 host 参数声明。 */
export const HOST_DESCRIPTION =
  "Host, or host:directory (see list_directories). Omit to use the current directory. A host on its own needs an absolute path; host:directory resolves relative paths from that directory.";

export const hostProperty = (description: string = HOST_DESCRIPTION) =>
  ({ type: "string", minLength: 1, description }) as const;
