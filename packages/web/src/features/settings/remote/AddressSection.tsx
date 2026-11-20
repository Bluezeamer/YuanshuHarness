import type { ConnectionView, ServerHost } from "../../../api/connections";
import {
  Button,
  Chip,
  fmtDateTime,
  Input,
  Select,
  SettingRow,
} from "../../../ui";
import { copyText } from "./actions";
import { type Editable, type EditErrors, jumpChoices, relTime } from "./model";

// 地址链：服务端 → 跳板… → 目标。节点绿点 = 已激活。
function JumpChain({
  c,
  all,
  server,
}: {
  c: ConnectionView;
  all: readonly ConnectionView[];
  server: ServerHost;
}) {
  const nodes = [
    { key: "server", name: "服务端", addr: server.host, on: true },
    ...c.chain.map((r) => {
      const j = all.find((x) => x.id === r.id);
      return {
        key: r.id,
        name: r.label,
        addr: j ? `${j.user}@${j.host}` : "",
        on: j?.status === "active",
      };
    }),
    {
      key: c.id,
      name: c.label,
      addr: `${c.user}@${c.host}`,
      on: c.status === "active",
    },
  ];
  return (
    <ol className="st-rc-chain" aria-label="跳板链">
      {nodes.map((n, i) => (
        <li key={n.key} className="st-rc-node" data-on={n.on || undefined}>
          {i > 0 && <span className="st-rc-node-line" aria-hidden="true" />}
          <span className="st-rc-node-box">
            <span className="st-rc-node-name t-entry">
              <span className="st-rc-node-dot" aria-hidden="true" />
              {n.name}
              <span className="sr-only">
                {n.on ? "（已激活）" : "（未激活）"}
              </span>
            </span>
            <span className="st-rc-node-addr t-mono">{n.addr}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AddressSection({
  c,
  all,
  server,
  draft,
  errors,
  locked,
  onChange,
  onTidy,
}: {
  c: ConnectionView;
  all: readonly ConnectionView[];
  server: ServerHost;
  draft: Editable;
  errors: EditErrors;
  /** 激活过程中地址类字段由服务端锁定 */
  locked: boolean;
  onChange: (patch: Partial<Editable>) => void;
  onTidy: () => void;
}) {
  const choices = jumpChoices(c.id, all);
  const hk = c.hostKeyChange
    ? {
        cap: <Chip tone="warn">待核对</Chip>,
        text: `${c.hostKeyChange.newType} · ${c.hostKeyChange.new}`,
        fp: null,
        sub: "激活前先核对指纹",
      }
    : c.hostKey
      ? {
          cap: <Chip tone="live">已信任</Chip>,
          text: `${c.hostKey.keyType} · ${c.hostKey.fingerprint}`,
          fp: c.hostKey.fingerprint,
          sub: c.hostKey.acceptedAt
            ? `记录于 ${fmtDateTime(c.hostKey.acceptedAt)}（${relTime(c.hostKey.acceptedAt)}）`
            : "已记录",
        }
      : {
          cap: <Chip>未记录</Chip>,
          text: "尚未记录，首次激活时核对",
          fp: null,
          sub: "首次连接时记录",
        };

  return (
    <section className="st-block" aria-label="地址">
      <header className="st-block-h t-group">地址</header>
      <p className="st-rc-note t-aux">
        {locked
          ? "激活过程中地址锁定，等结束后可编辑。"
          : "跳板链由服务端复用：先建立跳板通道，再从它拨号到目标。修改主机或端口会作废旧主机密钥记录，下次激活重新核对。"}
      </p>
      <JumpChain c={c} all={all} server={server} />
      <SettingRow label="主机" error={errors.host}>
        {(ctl) => (
          <Input
            {...ctl}
            mono
            disabled={locked}
            aria-label="主机名或 IP"
            spellCheck={false}
            autoComplete="off"
            value={draft.host}
            onChange={(e) => onChange({ host: e.target.value })}
            onBlur={onTidy}
          />
        )}
      </SettingRow>
      <SettingRow
        label="端口 / 用户"
        error={
          [errors.port, errors.user].filter(Boolean).join("；") || undefined
        }
      >
        <div className="st-rc-pair">
          <Input
            mono
            disabled={locked}
            inputMode="numeric"
            aria-label="端口"
            value={draft.port}
            onChange={(e) => onChange({ port: e.target.value })}
            onBlur={onTidy}
          />
          <Input
            mono
            disabled={locked}
            aria-label="登录用户"
            spellCheck={false}
            autoComplete="off"
            value={draft.user}
            onChange={(e) => onChange({ user: e.target.value })}
            onBlur={onTidy}
          />
        </div>
      </SettingRow>
      <SettingRow label="跳板机" description="至多一台">
        <Select
          aria-label="跳板机"
          disabled={locked}
          value={draft.jump}
          options={[
            { value: "", label: "直连" },
            ...choices.map(({ conn, reason }) => ({
              value: conn.id,
              label: `${conn.label} · ${conn.host}${reason ? `（${reason}）` : ""}`,
              disabled: reason !== null,
            })),
          ]}
          onChange={(jump) => onChange({ jump })}
        />
      </SettingRow>
      <SettingRow label="主机密钥" description={hk.sub}>
        <div className="st-rc-hkline">
          {hk.cap}
          <span className="st-rc-fp-inline t-mono" title={hk.text}>
            {hk.text}
          </span>
          {hk.fp && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyText(hk.fp, "已复制指纹")}
            >
              复制指纹
            </Button>
          )}
        </div>
      </SettingRow>
    </section>
  );
}
