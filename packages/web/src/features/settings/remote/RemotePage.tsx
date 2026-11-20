import { useState } from "react";
import type { ConnectionView } from "../../../api/connections";
import {
  Button,
  ConfirmDialog,
  Empty,
  Loading,
  TabPanel,
  toast,
} from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { FormColumn, ListColumn, Page, SplitPane } from "../frame/layout";
import { useLeaveGuard } from "../frame/leave";
import { PageTabs } from "../frame/PageTabs";
import { useRemote } from "./actions";
import { ConnDetail } from "./ConnDetail";
import { ConnList } from "./ConnList";
import { KeysTab } from "./KeysTab";
import { LogTab } from "./LogTab";
import { visibleConnections } from "./model";
import { NewConnModal } from "./NewConnModal";
import type { RemoteStore } from "./store";

type View = "conns" | "keys" | "log";

/** 远程连接。`store` 仅测试注入；正常使用不传。 */
export function RemotePage({ store: injected }: { store?: RemoteStore }) {
  const { store, state } = useRemote(injected);
  const guard = useLeaveGuard();
  const [view, setView] = useState<View>("conns");
  const [selId, setSelId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  if (state.phase === "loading") return <Loading>正在读取连接…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取连接失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );

  const { conns, creds } = state;
  const selected =
    conns.find((c) => c.id === selId) ??
    visibleConnections(conns, "")[0] ??
    null;
  // 把隐含的默认选中固化下来：否则连接的状态变了（断开、激活完成）排序一动，详情会跳到另一条
  if (selected && selected.id !== selId) setSelId(selected.id);
  const sshKeys = creds.filter((k) => k.kind === "ssh_key").length;

  const closeRemove = () => {
    setRemoving(null);
    setRemoveError(null);
  };
  const remove = async (c: ConnectionView) => {
    setBusy(true);
    const r = await store.remove(c.id);
    setBusy(false);
    if (!r.ok) return setRemoveError(r.message);
    closeRemove();
    setSelId(null);
    toast(`已删除「${c.label}」`, { tone: "ok" });
  };

  return (
    <Page>
      <PageTabs
        idBase="rc"
        aria-label="远程连接视图"
        value={view}
        onChange={(v) => guard(() => setView(v as View))}
        tabs={[
          { id: "conns", label: "连接", count: conns.length },
          { id: "keys", label: "密钥", count: sshKeys },
          { id: "log", label: "连接日志" },
        ]}
      />
      <TabPanel idBase="rc" id="conns" value={view} className="st-pane">
        <SplitPane
          rail={
            <ConnList
              state={state}
              selectedId={selected?.id ?? null}
              query={query}
              onQuery={setQuery}
              onSelect={(id) => guard(() => setSelId(id))}
              onAdd={() => guard(() => setCreating(true))}
              onRemove={setRemoving}
            />
          }
        >
          {selected ? (
            <ConnDetail
              key={selected.id}
              c={selected}
              state={state}
              store={store}
              onRemove={setRemoving}
            />
          ) : (
            <FormColumn>
              <Empty
                title="还没有连接"
                description="连接是执行环境，目录是环境里的目录。连接由服务端持有，关闭浏览器任务照常运行。新建一条 SSH 连接开始。"
                action={
                  <Button
                    variant="primary"
                    icon={<PlusIcon size={12} />}
                    onClick={() => setCreating(true)}
                  >
                    新建连接
                  </Button>
                }
              />
            </FormColumn>
          )}
        </SplitPane>
      </TabPanel>
      <TabPanel idBase="rc" id="keys" value={view} className="st-pane">
        <ListColumn>
          <KeysTab keys={creds} store={store} />
        </ListColumn>
      </TabPanel>
      <TabPanel idBase="rc" id="log" value={view} className="st-pane">
        <ListColumn>
          <LogTab conns={conns} />
        </ListColumn>
      </TabPanel>

      <NewConnModal
        open={creating}
        conns={conns}
        keys={creds}
        store={store}
        onClose={() => setCreating(false)}
        onCreated={(id, activate) => {
          setCreating(false);
          setQuery("");
          setSelId(id);
          if (activate) void store.activate(id);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `删除「${removing.label}」` : ""}
        confirmLabel="删除"
        busy={busy}
        error={removeError}
        onClose={closeRemove}
        onConfirm={() => removing && void remove(removing)}
      >
        只移除连接登记，不会删除远端任何文件。它的密码凭据一并清掉，私钥留在密钥库里。
      </ConfirmDialog>
    </Page>
  );
}
