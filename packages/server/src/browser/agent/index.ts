// agent 层对外的入口：工具、接管提问、站点授权判定。上层只从这一处取。

export {
  checkUploadTotal,
  UPLOAD_MAX_TOTAL_BYTES,
} from "../uploads/limits.js";
export {
  type AccessDecision,
  type AccessState,
  decideOpen,
  isHighValueHost,
} from "./access.js";
export {
  type ApproveDownloadDeps,
  type ApproveOpenDeps,
  type ApproveUploadDeps,
  answerVerdict,
  createApproveDownload,
  createApproveOpen,
  createApproveUpload,
  type Verdict,
} from "./approve.js";
export {
  type AuxCall,
  type Cleaner,
  type CleanInput,
  type CleanOutput,
  createCleaner,
  type PageReader,
} from "./clean/index.js";
export type { BrowserToolsDeps } from "./deps.js";
export {
  DOWNLOAD_GRACE_MS,
  DOWNLOAD_TIMEOUT_MS,
  isExecutableName,
  settleDownloads,
} from "./download.js";
export {
  type AskFn,
  askHandoff,
  type HandoffOutcome,
} from "./handoff.js";
export { BROWSER_TOOL_NAMES, browserTools } from "./tools.js";
export {
  type ResolvedUpload,
  readUploadSource,
  resolveUploadFile,
  UPLOAD_MAX_FILES,
  type UploadSource,
  type UploadSourceDeps,
} from "./upload.js";
