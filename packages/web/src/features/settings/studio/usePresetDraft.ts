// 一份预设的本地草稿：名称、描述、能力、段（含分组与条件）都先改在本地，点「保存」才提交；
// 「放弃」回到上次保存的样子。保存结果用右下角提示告知（ys-ui-design 的 X06）；
// 正在生效的全局 AGENTS.md 版本保存时要重写磁盘文件，文件被手改过就先停下来（diskConflict）让用户决定。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../../api/http";
import {
  getPreset,
  patchPreset,
  type StudioNode,
  type StudioPresetDetail,
  saveNodes,
} from "../../../api/studio";
import { toast } from "../../../ui";
import { useStudio } from "./useStudio";

export interface Draft {
  name: string;
  description: string;
  capabilities: string[] | null;
  capsAdd: string[];
  capsRemove: string[];
  nodes: StudioNode[];
}

const toDraft = (p: StudioPresetDetail): Draft => ({
  name: p.name,
  description: p.description,
  capabilities: p.capabilities,
  capsAdd: p.capsAdd,
  capsRemove: p.capsRemove,
  nodes: p.nodes,
});

const metaOf = ({ nodes: _nodes, ...meta }: Draft) => meta;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const messageOf = (err: unknown): string => {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string") return detail;
    return err.status === 0 ? "无法连接服务器" : "请稍后重试";
  }
  return "请稍后重试";
};

export function usePresetDraft(id: string) {
  const { reload } = useStudio();
  const [saved, setSaved] = useState<StudioPresetDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [diskConflict, setDiskConflict] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const r = await getPreset(id);
    if (!r.ok) return setFailed(true);
    setSaved(r.data);
    setDraft(toDraft(r.data));
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => saved !== null && draft !== null && !same(draft, toDraft(saved)),
    [saved, draft],
  );
  const edit = useCallback(
    (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    [],
  );

  // 先存段（可能因磁盘文件被手改而 409，那时什么都没改），再存名称与能力
  const save = useCallback(
    async (overwrite = false): Promise<boolean> => {
      if (!saved || !draft) return false;
      setSaving(true);
      try {
        const was = toDraft(saved);
        if (!same(draft.nodes, was.nodes))
          await saveNodes(id, draft.nodes, overwrite);
        if (!same(metaOf(draft), metaOf(was))) {
          const r = await patchPreset(id, metaOf(draft));
          if (!r.ok) {
            toast("保存失败：名称或能力没有通过校验", { tone: "danger" });
            return false;
          }
        }
        setDiskConflict(false);
        await load();
        await reload();
        toast("已保存", { tone: "ok" });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === "disk_modified")
          setDiskConflict(true);
        else toast(`保存失败：${messageOf(err)}`, { tone: "danger" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saved, draft, id, load, reload],
  );

  return {
    saved,
    draft,
    failed,
    dirty,
    saving,
    diskConflict,
    cancelConflict: () => setDiskConflict(false),
    edit,
    save,
    discard: () => {
      if (!saved) return;
      setDraft(toDraft(saved));
      setDiskConflict(false);
    },
    reloadSaved: load,
  };
}
