// 用户操作的页面上开始了一次下载：问存到哪（本机 / 工作区目录）或丢弃。
// 关闭弹窗（Esc、右上角）等同于丢弃：待处理项还在状态里，不丢弃它会立刻又弹出来。
import { useState } from "react";
import type { PendingDownload } from "../../../../api/browser";
import { Button, Field, FileTypeIcon, Modal, Select } from "../../../../ui";

export interface DownloadDialogProps {
  item: PendingDownload;
  /** 这一页上还有几个在排队 */
  more: number;
  directories: readonly { id: string; name: string }[];
  /** 三个动作：失败的提示由调用方弹出（出错的下载在 Server 里已作废，弹窗随之关掉，留不住行内提示）；成功后弹窗随页面状态更新自行消失 */
  onSaveLocal(): Promise<void>;
  onPut(directoryId: string): Promise<void>;
  onDiscard(): Promise<void>;
}

type Doing = "local" | "put" | "discard";

export function DownloadDialog({
  item,
  more,
  directories,
  onSaveLocal,
  onPut,
  onDiscard,
}: DownloadDialogProps) {
  const [doing, setDoing] = useState<Doing | null>(null);
  const [dir, setDir] = useState(directories[0]?.id ?? "");

  const run = async (what: Doing, action: () => Promise<void>) => {
    setDoing(what);
    await action();
    setDoing(null);
  };

  return (
    <Modal
      open
      onClose={() => doing === null && void run("discard", onDiscard)}
      size="sm"
      title="保存下载的文件"
      description="页面里开始了一次下载，选择把它放到哪里。"
      dismissOnScrim={false}
      footer={
        <>
          <div className="u-form-aside">
            <Button
              variant="ghost"
              size="lg"
              loading={doing === "discard"}
              disabled={doing !== null}
              onClick={() => void run("discard", onDiscard)}
            >
              丢弃
            </Button>
          </div>
          {directories.length > 0 && (
            <Button
              size="lg"
              loading={doing === "put"}
              disabled={doing !== null || dir === ""}
              onClick={() => void run("put", () => onPut(dir))}
            >
              放进工作区目录
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            loading={doing === "local"}
            disabled={doing !== null}
            onClick={() => void run("local", onSaveLocal)}
          >
            保存到本机
          </Button>
        </>
      }
    >
      <div className="u-form">
        <div className="ws-dl-file">
          <FileTypeIcon name={item.filename} />
          <span className="ws-dl-name t-entry" title={item.filename}>
            {item.filename}
          </span>
        </div>
        {directories.length > 1 && (
          <Field label="放进哪个目录">
            {(control) => (
              <Select
                {...control}
                value={dir}
                onChange={setDir}
                options={directories.map((d) => ({
                  value: d.id,
                  label: d.name,
                }))}
              />
            )}
          </Field>
        )}
        {more > 0 && (
          <p className="ws-dl-more t-aux">还有 {more} 个下载在等你处理</p>
        )}
      </div>
    </Modal>
  );
}
