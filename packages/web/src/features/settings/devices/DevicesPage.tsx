import { useState } from "react";
import { Button, ConfirmButton, Empty, Loading, SettingRow } from "../../../ui";
import { fmtDateTime } from "../../../ui/time";
import { FormPane, Page } from "../frame/layout";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { useDevices } from "./useDevices";

/** 手机设备：每台手机一个独立令牌，在这里添加（扫码配对）、查看最近使用、撤销。撤销立刻生效，已开的连接一并断开。 */
export function DevicesPage() {
  const { state, load, revoke } = useDevices();
  const [adding, setAdding] = useState(false);

  if (state.phase === "loading") return <Loading>正在读取设备…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取设备失败"
        description="请稍后重试。"
        action={<Button onClick={() => void load()}>重试</Button>}
      />
    );

  const { devices } = state;
  return (
    <Page>
      <FormPane>
        <section className="st-block" aria-label="手机设备">
          <header className="st-block-h t-group">手机设备</header>
          <p className="st-dv-note t-aux">
            手机访问元枢走
            /m/，每台手机有自己的令牌，不用共用你的访问令牌；手机丢了或不用了，在这里撤销即可。
          </p>
          {devices.length === 0 ? (
            <Empty
              compact
              title="还没有添加手机"
              description="点「添加手机」，用手机扫二维码就能登录。"
            />
          ) : (
            devices.map((d) => (
              <SettingRow
                key={d.id}
                className="st-dv-row"
                label={d.name}
                description={`添加于 ${fmtDateTime(d.createdAt)} · ${
                  d.lastUsedAt
                    ? `最近使用 ${fmtDateTime(d.lastUsedAt)}`
                    : "还没有使用过"
                }`}
              >
                <div className="st-dv-ctl">
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    aria-label={`撤销 ${d.name}`}
                    armedLabel="再点一次撤销"
                    onConfirm={() => void revoke(d)}
                  >
                    撤销
                  </ConfirmButton>
                </div>
              </SettingRow>
            ))
          )}
          <div className="st-dv-foot">
            <Button variant="primary" onClick={() => setAdding(true)}>
              添加手机
            </Button>
          </div>
        </section>
      </FormPane>
      <AddDeviceDialog
        open={adding}
        onClose={() => setAdding(false)}
        deviceCount={devices.length}
        reload={async () => (await load())?.length ?? null}
      />
    </Page>
  );
}
