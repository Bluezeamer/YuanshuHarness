import { useCallback, useEffect, useState } from "react";
import {
  type GlobalAgentsMdState,
  getGlobalAgentsMdState,
  importGlobalAgentsMd,
} from "../../../api/agentsMd";
import { ApiError, loadToken } from "../../../api/http";
import { activatePreset, type StudioPreset } from "../../../api/studio";
import { Button, Modal, toast } from "../../../ui";
import { useStudio } from "./useStudio";

/** 全局 AGENTS.md 文件现在的状态（有没有被手改过）；激活、导入之后要 refresh */
export function useGlobalFile() {
  const [state, setState] = useState<GlobalAgentsMdState | null>(null);
  const refresh = useCallback(
    () =>
      getGlobalAgentsMdState(loadToken()).then(setState, () => setState(null)),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { state, refresh };
}

/**
 * 磁盘上的全局 AGENTS.md 被手改过，而接下来的操作要重写它：问用户怎么办。
 * onImport 给了才有「另存为新版本」（激活时可以先把磁盘内容存下来；保存生效版本时没有这个选项）。
 */
export function DiskModifiedDialog({
  open,
  path,
  verb,
  onCancel,
  onOverwrite,
  onImport,
  busy,
}: {
  open: boolean;
  path: string;
  /** 「激活「x」」或「保存这个版本」，写进说明里 */
  verb: string;
  onCancel: () => void;
  onOverwrite: () => void;
  onImport?: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title="磁盘上的文件被改动过"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant={onImport ? "outline" : "primary"}
            size="lg"
            loading={busy ?? false}
            onClick={onOverwrite}
          >
            直接覆盖
          </Button>
          {onImport && (
            <Button
              variant="primary"
              size="lg"
              loading={busy ?? false}
              onClick={onImport}
            >
              另存为新版本再继续
            </Button>
          )}
        </>
      }
    >
      <p className="t-plain">
        <span className="t-mono">{path}</span> 里有不在任何版本里的修改。{verb}
        会把它重写成这个版本的内容，现有修改会丢掉。
      </p>
    </Modal>
  );
}

const failText = (err: unknown) =>
  err instanceof ApiError && err.status === 0 ? "无法连接服务器" : "请稍后重试";

/**
 * 设为生效。全局 AGENTS.md 版本会写磁盘文件：文件被手改过时先问「直接覆盖 / 另存为新版本再激活 / 取消」。
 * 其余种类（全局附加提示词）直接生效。
 */
export function useActivate(file: ReturnType<typeof useGlobalFile>) {
  const { reload } = useStudio();
  const [asking, setAsking] = useState<StudioPreset | null>(null);
  const [busy, setBusy] = useState(false);

  const done = async (p: StudioPreset) => {
    await Promise.all([reload(), file.refresh()]);
    toast(
      p.kind === "global-agentsmd"
        ? `已激活「${p.name}」，已写入 ${file.state?.path ?? "~/.ys/AGENTS.md"}`
        : `已将「${p.name}」设为生效`,
      { tone: "ok" },
    );
  };

  const run = async (p: StudioPreset, overwrite: boolean) => {
    setBusy(true);
    try {
      await activatePreset(p.id, overwrite);
      setAsking(null);
      await done(p);
    } catch (err) {
      if (err instanceof ApiError && err.code === "disk_modified") setAsking(p);
      else toast(`设为生效失败：${failText(err)}`, { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const importThenRun = async (p: StudioPreset) => {
    setBusy(true);
    try {
      await importGlobalAgentsMd(loadToken());
    } catch (err) {
      setBusy(false);
      toast(`另存失败：${failText(err)}`, { tone: "danger" });
      return;
    }
    setBusy(false);
    // 导入的版本已经是生效版本、磁盘与它一致，再激活目标版本就不会再被拦
    await run(p, false);
  };

  return {
    request: (p: StudioPreset) => void run(p, false),
    dialog: (
      <DiskModifiedDialog
        open={asking !== null}
        path={file.state?.path ?? "~/.ys/AGENTS.md"}
        verb={`激活「${asking?.name ?? ""}」`}
        busy={busy}
        onCancel={() => setAsking(null)}
        onOverwrite={() => asking && void run(asking, true)}
        onImport={() => asking && void importThenRun(asking)}
      />
    ),
  };
}
