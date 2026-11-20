import { useState } from "react";
import {
  Button,
  ConfirmButton,
  ConfirmDialog,
  Empty,
  Input,
  Loading,
  SettingRow,
  Switch,
} from "../../../ui";
import { FormPane, Page } from "../frame/layout";
import { useBindDirty } from "../frame/leave";
import { SaveBar } from "../frame/SaveBar";
import { useDraft } from "../frame/useDraft";
import { describeLogin, mirrorError } from "./model";
import { useLogins } from "./useLogins";
import { useMirror } from "./useMirror";

/** 浏览器设置：下载镜像（一项设置，走保存条）与已保存的登录状态（全局、一个站点一份，动作立即执行）。 */
export function BrowserPage() {
  const { state, retry, save } = useMirror();
  if (state.phase === "loading") return <Loading>正在读取浏览器设置…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取浏览器设置失败"
        description={state.message}
        action={<Button onClick={retry}>重试</Button>}
      />
    );
  return <Ready mirror={state.saved} saveMirror={save} />;
}

function Ready({
  mirror,
  saveMirror,
}: {
  mirror: string;
  saveMirror: (draft: string) => Promise<string | null>;
}) {
  const { state, reload, toggle, remove, clear } = useLogins();
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = useDraft(mirror, saveMirror);
  useBindDirty({ dirty: d.dirty, save: d.save, discard: d.discard });

  if (state.phase === "loading") return <Loading>正在读取登录状态…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取登录状态失败"
        description={state.message}
        action={<Button onClick={() => void reload()}>重试</Button>}
      />
    );

  const { logins } = state;
  return (
    <Page>
      <FormPane
        footer={
          <SaveBar
            dirty={d.dirty}
            saving={d.saving}
            onSave={() => void d.save()}
            onDiscard={d.discard}
          />
        }
      >
        <section className="st-block" aria-label="浏览器下载">
          <header className="st-block-h t-group">浏览器下载</header>
          <SettingRow
            label="下载镜像"
            description="安装浏览器（Chromium）时的下载地址前缀，留空走官方源；国内网络可填镜像。下次安装生效；留空时仍认环境变量 PLAYWRIGHT_DOWNLOAD_HOST。"
            error={mirrorError(d.draft) ?? undefined}
          >
            {(c) => (
              <Input
                {...c}
                mono
                placeholder="留空 = 官方源"
                value={d.draft}
                // 地址里不会有空白：粘贴带进来的首尾空白直接去掉，草稿与服务端存的保持同一个样子
                onChange={(e) => d.setDraft(e.target.value.replace(/\s/g, ""))}
              />
            )}
          </SettingRow>
        </section>
        <section className="st-block" aria-label="登录状态">
          <header className="st-block-h t-group">登录状态</header>
          <p className="st-bl-note t-aux">
            {
              "在浏览器标签里手动登录后保存，之后新开的浏览器（Server 重启、浏览器崩溃、别的工作区）遇到同一站点就不用再登录；已经开着的浏览器本来就记得登录，不受保存与否影响。状态加密保存在 Server 上，所有工作区共用；只有开着「允许 agent 使用」的站点会被带进新浏览器。"
            }
          </p>
          {logins.length === 0 ? (
            <Empty
              compact
              title="还没有保存登录状态"
              description="在浏览器标签里手动登录后，交还 agent 时会问你要不要保存；也可以随时点工具条上的「保存登录」。"
            />
          ) : (
            logins.map((m) => (
              <SettingRow
                key={m.site}
                label={m.site}
                description={describeLogin(m)}
              >
                <div className="st-bl-ctl">
                  <Switch
                    aria-label={`允许 agent 使用 ${m.site} 的登录状态`}
                    checked={m.enabled}
                    onChange={(on) => void toggle(m.site, on)}
                  />
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    aria-label={`删除 ${m.site} 的登录状态`}
                    onConfirm={() => void remove(m.site)}
                  >
                    删除
                  </ConfirmButton>
                </div>
              </SettingRow>
            ))
          )}
          {logins.length > 0 && (
            <div className="st-bl-foot">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setClearing(true)}
              >
                清空全部
              </Button>
            </div>
          )}
        </section>
      </FormPane>

      <ConfirmDialog
        open={clearing}
        title="清空全部登录状态"
        confirmLabel="清空"
        busy={busy}
        onClose={() => setClearing(false)}
        onConfirm={() => {
          setBusy(true);
          void clear().finally(() => {
            setBusy(false);
            setClearing(false);
          });
        }}
      >
        删除 {logins.length} 个站点保存的登录状态。agent
        之后打开这些站点需要重新登录；浏览器里已经打开的页面不受影响。
      </ConfirmDialog>
    </Page>
  );
}
