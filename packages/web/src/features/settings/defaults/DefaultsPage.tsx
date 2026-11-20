import { useState } from "react";
import { Button, Empty, Loading, TabPanel } from "../../../ui";
import { FormPane, Page } from "../frame/layout";
import { useBindDirty, useLeaveGuard } from "../frame/leave";
import { PageTabs } from "../frame/PageTabs";
import { SaveBar } from "../frame/SaveBar";
import { useDraft } from "../frame/useDraft";
import { InputTab } from "./InputTab";
import { ModelsTab } from "./ModelsTab";
import { errorsOf } from "./model";
import { SessionTab } from "./SessionTab";
import { useDefaults } from "./useDefaults";

type View = "models" | "session" | "input";

/**
 * 默认值设置：所有带默认值的全局设置，按用途分三个页签；
 * 除界面字号（本机设置、即时生效）外整页共用一份草稿和一个保存条（ys-ui-design 的 X06）。
 */
export function DefaultsPage() {
  const { state, retry, save } = useDefaults();
  if (state.phase === "loading") return <Loading>正在读取默认值…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取默认值失败"
        description={state.message}
        action={<Button onClick={retry}>重试</Button>}
      />
    );
  return <Ready state={state} save={save} />;
}

function Ready({
  state,
  save,
}: {
  state: Extract<ReturnType<typeof useDefaults>["state"], { phase: "ready" }>;
  save: ReturnType<typeof useDefaults>["save"];
}) {
  const guard = useLeaveGuard();
  const [view, setView] = useState<View>("models");
  const d = useDraft(state.saved, save);
  useBindDirty({ dirty: d.dirty, save: d.save, discard: d.discard });

  const tab = {
    form: d.draft,
    errors: errorsOf(d.draft),
    set: (patch: Partial<typeof d.draft>) =>
      d.setDraft({ ...d.draft, ...patch }),
  };
  const footer = (
    <SaveBar
      dirty={d.dirty}
      saving={d.saving}
      onSave={() => void d.save()}
      onDiscard={d.discard}
    />
  );

  return (
    <Page>
      <PageTabs
        idBase="df"
        aria-label="默认值分组"
        value={view}
        onChange={(v) => guard(() => setView(v as View))}
        tabs={[
          { id: "models", label: "模型与权限" },
          { id: "session", label: "会话与任务" },
          { id: "input", label: "输入与显示" },
        ]}
      />
      <TabPanel idBase="df" id="models" value={view} className="st-pane">
        <FormPane footer={footer}>
          <ModelsTab {...tab} providers={state.providers} />
        </FormPane>
      </TabPanel>
      <TabPanel idBase="df" id="session" value={view} className="st-pane">
        <FormPane footer={footer}>
          <SessionTab {...tab} agent={state.agent} />
        </FormPane>
      </TabPanel>
      <TabPanel idBase="df" id="input" value={view} className="st-pane">
        <FormPane footer={footer}>
          <InputTab {...tab} />
        </FormPane>
      </TabPanel>
    </Page>
  );
}
