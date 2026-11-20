// 手动操作结束后的一行提示：站点的登录状态与已保存的不同时，问要不要保存。
// 样式与接管横幅同一套（ws-wb-strip）；保存失败的原因留在这一行里，不关。
import { useState } from "react";
import { Button, InlineNotice } from "../../../../ui";

export interface LoginStripProps {
  site: string;
  /** 返回失败原因（中文）；成功返回 null，调用方随即撤掉这一行 */
  onSave(): Promise<string | null>;
  onDismiss(): void;
}

export function LoginStrip({ site, onSave, onDismiss }: LoginStripProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const failed = await onSave();
    setBusy(false);
    if (failed) setError(failed);
  };

  return (
    <div className="ws-wb-strip">
      <InlineNotice tone={error ? "danger" : "info"}>
        {error ??
          `保存 ${site} 的登录状态？之后 agent 打开这个站点就不用再登录。`}
      </InlineNotice>
      <div className="ws-wb-strip-actions">
        <Button size="sm" loading={busy} onClick={() => void save()}>
          保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          忽略
        </Button>
      </div>
    </div>
  );
}
