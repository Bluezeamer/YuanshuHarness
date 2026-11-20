// 附件下载的响应头：两处（api/files.ts、api/attachments.ts）与浏览器下载共用同一份写法。
// HTTP 头只能放 ASCII，文件名走 RFC 5987 的 filename*（编码后中文也能带出去）。
export const attachmentDisposition = (name: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
