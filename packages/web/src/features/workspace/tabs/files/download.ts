// 右键下载：文件原样给，文件夹由服务端流式打成 zip；都走带令牌的 fetch，拿到后交给浏览器另存。
// 进度借传输条的作业卡片：文件夹要等打包，整体大小未知，只给进行中的条。
import {
  type FileEntry,
  readArchive,
  readDownload,
} from "../../../../api/files";
import { loadToken } from "../../../../api/http";
import { saveBlob } from "../../../../ui";
import { FAIL } from "../preview/kind";
import { sizeText } from "./paths";
import { addJob, patchJob, settleJob } from "./transfer";

export async function downloadEntry(
  env: string,
  path: string,
  entry: FileEntry,
): Promise<void> {
  const isDir = entry.type === "dir";
  const jobId = addJob({
    phase: "running",
    title: `下载 ${entry.name}`,
    detail: isDir ? "打包为 zip" : sizeText(entry.size),
    progress: null,
    error: null,
  });
  const r = await (isDir ? readArchive : readDownload)(loadToken(), env, path);
  if (!r.ok) {
    patchJob(jobId, {
      phase: "failed",
      title: `下载 ${entry.name} 失败`,
      detail: null,
      error: FAIL[r.kind],
    });
    return;
  }
  saveBlob(r.data, isDir ? `${entry.name}.zip` : entry.name);
  patchJob(jobId, {
    phase: "done",
    title: `已下载 ${entry.name}`,
    detail: null,
    progress: 1,
  });
  settleJob(jobId);
}
