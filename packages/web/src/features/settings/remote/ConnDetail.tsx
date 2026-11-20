import { useState } from "react";
import type { ConnectionView } from "../../../api/connections";
import { Button, ConfirmDialog, InlineNotice, Menu, toast } from "../../../ui";
import { RemoteIcon } from "../../../ui/icons";
import { DetailHead } from "../frame/DetailHead";
import { FormColumn } from "../frame/layout";
import { useBindDirty } from "../frame/leave";
import { SaveBar } from "../frame/SaveBar";
import { useDraft } from "../frame/useDraft";
import { AddressSection } from "./AddressSection";
import { AuthSection, PolicySection } from "./AuthPolicySection";
import { connMenu, type Ready } from "./actions";
import { MountsSection } from "./Mounts";
import {
  addrOf,
  disconnectImpact,
  type Editable,
  editableOf,
  patchOf,
  stateOf,
  tidy,
  validateEdit,
} from "./model";
import { Notices } from "./Notices";
import { mountsOf, type RemoteStore } from "./store";

export interface ConnDetailProps {
  c: ConnectionView;
  state: Ready;
  store: RemoteStore;
  onRemove: (c: ConnectionView) => void;
}

const names = (list: readonly { label: string }[]) =>
  list.map((r) => `「${r.label}」`).join("、");

/**
 * 连接详情。父级用 key={c.id} 挂载，切换连接时本地状态自然重置。
 * 激活、断开、信任是即时动作；地址、认证、策略进草稿，点保存才落（ys-ui-design 的 X06）。
 */
export function ConnDetail({ c, state, store, onRemove }: ConnDetailProps) {
  const saved = editableOf(c);
  const [password, setPassword] = useState("");
  const d = useDraft(saved, async (draft) => {
    const first = Object.values(validateEdit(draft, saved, password))[0];
    if (first) return first;
    const { input, password: pw } = patchOf(draft, saved, password);
    if (Object.keys(input).length === 0 && pw === undefined) return null;
    const r = await store.update(c.id, input, pw);
    if (!r.ok) return r.message;
    setPassword("");
    return null;
  });
  const dirty = d.dirty || password !== "";
  useBindDirty({
    dirty,
    save: d.save,
    discard: () => {
      d.discard();
      setPassword("");
    },
  });

  const [disconnecting, setDisconnecting] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [activationHidden, setActivationHidden] = useState(false);
  const [hostKeyDismissed, setHostKeyDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trusting, setTrusting] = useState(false);

  const st = stateOf(c);
  const mounts = mountsOf(state, c.id);
  const impact = disconnectImpact(
    c,
    state.conns,
    (id) => mountsOf(state, id).sessions,
  );
  const running = c.status === "activating" || state.starting === c.id;
  // 全页只允许一个连接处于激活过程中（B9）
  const other = state.conns.find(
    (x) => x.id !== c.id && x.status === "activating",
  );
  const lockedByOther =
    other !== undefined || (state.starting !== null && state.starting !== c.id);

  // 重新开始一次激活前清掉上一轮的界面残留
  const reset = () => {
    setError(null);
    setActivationHidden(false);
    setHostKeyDismissed(false);
  };
  const settle = (r: { ok: boolean; message?: string }) =>
    setError(r.ok ? null : (r.message ?? null));

  const activate = async () => {
    reset();
    if (c.auth.kind === null) return setPasswordOpen(true);
    // 跳板没激活就拒绝，不发请求；服务端也会拒（409 jump_inactive）
    const jump = c.jump[0] ? state.conns.find((x) => x.id === c.jump[0]) : null;
    if (jump && jump.status !== "active") {
      setError(`跳板机「${jump.label}」还没有激活，先激活跳板机再激活它。`);
      return;
    }
    settle(await store.activate(c.id));
  };

  const disconnect = async () => {
    setDisconnecting(false);
    reset();
    const r = await store.deactivate(c.id);
    if (!r.ok) return setError(r.message);
    const [self, ...down] = r.data.deactivated;
    toast(
      `已断开${self ? names([self]) : ""}${down.length > 0 ? `，连带暂停 ${down.length} 条下游连接：${names(down)}` : ""}。`,
      { tone: "ok" },
    );
  };

  const trust = async () => {
    setTrusting(true);
    settle(await store.trustAndActivate(c.id));
    setTrusting(false);
  };

  const patch = (p: Partial<Editable>) => d.setDraft({ ...d.draft, ...p });
  const errors = validateEdit(d.draft, saved, password);
  const locked = c.status === "activating";

  return (
    <>
      <FormColumn>
        <article aria-label={`${c.label} 详情`}>
          <DetailHead
            icon={<RemoteIcon size={18} />}
            title={c.label}
            sub={<span className="t-mono">{addrOf(c)}</span>}
            status={{ text: st.label, tone: st.tone, motion: st.motion }}
            actions={
              <>
                {c.status === "active" ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      reset();
                      if (impact.needsConfirm) setDisconnecting(true);
                      else void disconnect();
                    }}
                  >
                    断开
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    loading={running}
                    disabled={lockedByOther || dirty}
                    title={
                      dirty
                        ? "先保存修改再激活"
                        : lockedByOther
                          ? `正在激活「${other?.label ?? "另一条连接"}」，等它结束后再激活`
                          : undefined
                    }
                    onClick={() => void activate()}
                  >
                    {running ? "激活中" : "激活"}
                  </Button>
                )}
                <Menu label="更多操作" items={connMenu(c, state, onRemove)} />
              </>
            }
          />

          {error && (
            <InlineNotice tone="danger" className="st-rc-err">
              {error}
            </InlineNotice>
          )}
          <Notices
            c={c}
            passwordOpen={passwordOpen}
            activationHidden={activationHidden}
            hostKeyDismissed={hostKeyDismissed}
            busy={trusting || running}
            onSubmitPassword={(pw) => {
              void store.setPassword(c.id, pw).then(async (r) => {
                if (!r.ok) return setError(r.message);
                setPasswordOpen(false);
                settle(await store.activate(c.id));
              });
            }}
            onCancelPassword={() => setPasswordOpen(false)}
            onHideActivation={() => setActivationHidden(true)}
            onCancelActivation={() => void disconnect()}
            onTrust={() => void trust()}
            onDismissHostKey={() => setHostKeyDismissed(true)}
          />

          <AddressSection
            c={c}
            all={state.conns}
            server={state.server}
            draft={d.draft}
            errors={errors}
            locked={locked}
            onChange={patch}
            onTidy={() => d.setDraft(tidy(d.draft))}
          />
          <AuthSection
            c={c}
            keys={state.creds}
            draft={d.draft}
            password={password}
            errors={errors}
            onChange={patch}
            onPassword={setPassword}
          />
          <PolicySection draft={d.draft} onChange={patch} />
          <MountsSection directories={mounts.directories} />
        </article>
      </FormColumn>
      <SaveBar
        dirty={dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={() => {
          d.discard();
          setPassword("");
        }}
      />
      <ConfirmDialog
        open={disconnecting}
        title={`断开「${c.label}」`}
        confirmLabel="断开并暂停"
        tone="primary"
        onClose={() => setDisconnecting(false)}
        onConfirm={() => void disconnect()}
      >
        {impact.sessions > 0 &&
          `${impact.sessions} 个会话会暂停，重新激活后继续；`}
        {impact.downstream.length > 0 &&
          `${impact.downstream.length} 条经它跳转的连接（${names(impact.downstream)}）也会一起暂停；`}
        目录与未保存的改动不受影响。
      </ConfirmDialog>
    </>
  );
}
