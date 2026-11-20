import { useState } from "react";
import type { ProviderView } from "../../../api/providers";
import { Button, InlineNotice, Menu } from "../../../ui";
import { DetailHead } from "../frame/DetailHead";
import { FormColumn } from "../frame/layout";
import { useBindDirty } from "../frame/leave";
import { SaveBar } from "../frame/SaveBar";
import { useDraft } from "../frame/useDraft";
import { AdvancedSection } from "./AdvancedSection";
import { ConnectionSection } from "./ConnectionSection";
import { explainFailure, fmtMs } from "./diagnose";
import { editableOf, patchOf, validateEdit } from "./edit";
import { ModelsSection } from "./ModelsSection";
import { apiLabel, monogram, statusInfo } from "./model";
import type { ProvidersStore } from "./store";

export interface ProviderDetailProps {
  p: ProviderView;
  store: ProvidersStore;
  testing: boolean;
  onTest: () => void;
  onRemove: () => void;
}

/**
 * 供应商详情。父级用 key={p.id} 挂载，切换供应商时草稿自然重置。
 * 测试连接、登录、退出登录、移除密钥、模型的增删改是动作，立即执行；
 * 连接、高级里的项进草稿，点保存才落（ys-ui-design 的 X06）。
 */
export function ProviderDetail({
  p,
  store,
  testing,
  onTest,
  onRemove,
}: ProviderDetailProps) {
  const saved = editableOf(p);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const d = useDraft(saved, async (draft) => {
    const first = Object.values(validateEdit(draft, p))[0];
    if (first) return first;
    const patch = patchOf(draft, p, apiKey ?? "");
    if (Object.keys(patch).length > 0) {
      const r = await store.update(p.id, () => patch);
      if (!r.ok) return r.message;
      // 以服务端回来的为准：去掉首尾空白、补上默认值后，草稿与已保存值要对得上
      d.setDraft(editableOf(r.data));
    }
    setApiKey(null);
    return null;
  });
  const dirty = d.dirty || (apiKey ?? "") !== "";
  const discard = () => {
    d.discard();
    setApiKey(null);
  };
  useBindDirty({ dirty, save: d.save, discard });

  const st = statusInfo(p);
  const errors = validateEdit(d.draft, p);
  const last = p.lastTest;
  const patch = (next: Partial<typeof d.draft>) =>
    d.setDraft({ ...d.draft, ...next });
  const shared = { p, store, draft: d.draft, errors, onChange: patch };

  return (
    <>
      <FormColumn>
        <article aria-label={`${p.name} 详情`}>
          <DetailHead
            icon={<span className="t-group">{monogram(p.name)}</span>}
            title={p.name}
            sub={`${p.api ? apiLabel(p.api) : p.id}${p.custom ? " · 自定义端点" : ""}`}
            status={{
              text: last?.ok
                ? `${st.label} · 首 token ${fmtMs(last.ttft)}`
                : st.label,
              tone: st.tone,
            }}
            actions={
              <>
                <Button
                  variant="outline"
                  loading={testing}
                  disabled={dirty}
                  title={dirty ? "先保存修改再测试" : undefined}
                  onClick={onTest}
                >
                  测试连接
                </Button>
                <Menu
                  label="更多操作"
                  items={[
                    {
                      id: "remove",
                      label: "删除",
                      tone: "danger",
                      onSelect: onRemove,
                    },
                  ]}
                />
              </>
            }
          />
          {last && !last.ok && (
            <InlineNotice className="pv-result" tone="danger">
              <span className="t-entry">
                上次测试失败：
                {explainFailure(last.stage, last.errorCode ?? null).title}
              </span>{" "}
              {explainFailure(last.stage, last.errorCode ?? null).hint}
            </InlineNotice>
          )}

          <ConnectionSection {...shared} apiKey={apiKey} onApiKey={setApiKey} />
          <ModelsSection p={p} store={store} />
          <AdvancedSection {...shared} />
        </article>
      </FormColumn>
      <SaveBar
        dirty={dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={discard}
      />
    </>
  );
}
