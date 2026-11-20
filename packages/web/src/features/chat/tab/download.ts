// 附件下载：取 blob 后交给浏览器保存；失败提示中文原因。
import { downloadAttachment } from "../../../api/attachments";
import { loadToken } from "../../../api/http";
import { toast } from "../../../ui";

export async function saveAttachment(
  sessionId: string,
  path: string,
  name: string,
): Promise<void> {
  const r = await downloadAttachment(loadToken(), sessionId, path, name);
  if (!r.ok) toast(r.message, { tone: "danger" });
}
