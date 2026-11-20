// 用户操作的页面里点了「选择文件」：选你电脑上的文件交给页面，或取消。
// 关闭弹窗（Esc、右上角）等同于取消：待处理项还在状态里，不取消它会立刻又弹出来。
import { useRef, useState } from "react";
import type { PendingUpload } from "../../../../api/browser";
import {
  Button,
  FileTypeIcon,
  IconButton,
  InlineNotice,
  Modal,
} from "../../../../ui";
import { CloseIcon } from "../../../../ui/icons";
import { sizeText } from "../files/paths";

// 浏览器一次能接收的合计上限，与服务端 UPLOAD_MAX_TOTAL_BYTES 一致：超了就别白传一遍。
export const UPLOAD_TOTAL_MAX = 50 * 1024 * 1024;

export interface UploadDialogProps {
  item: PendingUpload;
  /** 两个动作：失败的提示由调用方弹出；成功后弹窗随页面状态更新自行消失 */
  onUpload(files: File[]): Promise<void>;
  onCancel(): Promise<void>;
}

type Doing = "upload" | "cancel";

const sameFile = (a: File, b: File) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

export function UploadDialog({ item, onUpload, onCancel }: UploadDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [doing, setDoing] = useState<Doing | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const tooBig = total >= UPLOAD_TOTAL_MAX;

  const run = async (what: Doing, action: () => Promise<void>) => {
    setDoing(what);
    await action();
    setDoing(null);
  };

  const picked = (list: FileList | null) => {
    const next = Array.from(list ?? []);
    // 同一个文件选两次没有意义：名字、大小、修改时间都相同的只留一份
    const fresh = next.filter((n) => !files.some((f) => sameFile(f, n)));
    if (next.length > 0) setFiles(item.multiple ? [...files, ...fresh] : next);
    // 清掉值，同一个文件移除后还能再选
    if (input.current) input.current.value = "";
  };

  return (
    <Modal
      open
      onClose={() => doing === null && void run("cancel", onCancel)}
      size="sm"
      title="选择要上传的文件"
      description={
        item.multiple
          ? "页面请求选择文件，可以选多个。"
          : "页面请求选择文件，选一个你电脑上的文件。"
      }
      dismissOnScrim={false}
      footer={
        <>
          <div className="u-form-aside">
            <Button
              variant="ghost"
              size="lg"
              loading={doing === "cancel"}
              disabled={doing !== null}
              onClick={() => void run("cancel", onCancel)}
            >
              取消
            </Button>
          </div>
          <Button
            variant="primary"
            size="lg"
            loading={doing === "upload"}
            disabled={doing !== null || files.length === 0 || tooBig}
            onClick={() => void run("upload", () => onUpload(files))}
          >
            上传
          </Button>
        </>
      }
    >
      <div className="u-form">
        <input
          ref={input}
          type="file"
          multiple={item.multiple}
          hidden
          data-file-input=""
          onChange={(e) => picked(e.target.files)}
        />
        <div>
          <Button
            disabled={doing !== null}
            onClick={() => input.current?.click()}
          >
            {files.length === 0
              ? "选择文件…"
              : item.multiple
                ? "继续添加…"
                : "更换…"}
          </Button>
        </div>
        {files.length > 0 && (
          <ul className="ws-ul-list">
            {files.map((f) => (
              <li key={`${f.name}-${f.size}-${f.lastModified}`}>
                <FileTypeIcon name={f.name} />
                <span className="ws-ul-name t-entry" title={f.name}>
                  {f.name}
                </span>
                <span className="ws-ul-size t-aux">{sizeText(f.size)}</span>
                <IconButton
                  size="sm"
                  label={`移除 ${f.name}`}
                  icon={<CloseIcon size={12} />}
                  disabled={doing !== null}
                  onClick={() => setFiles(files.filter((x) => x !== f))}
                />
              </li>
            ))}
          </ul>
        )}
        {tooBig && (
          <InlineNotice tone="warn">
            合计 {sizeText(total)}，超过浏览器一次能接收的 50
            MB：少选几个，或先压缩。
          </InlineNotice>
        )}
      </div>
    </Modal>
  );
}
