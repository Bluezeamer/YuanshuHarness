import { useState } from "react";
import type { ProviderView } from "../../../api/providers";
import { Button, Chip, Modal, SettingRow } from "../../../ui";
import { TIER_LABEL } from "./model";

// 凭据解析顺序：四层，第一个能解析的来源生效。
function CredentialChain({ p }: { p: ProviderView }) {
  const { source, chain } = p.credential;
  return (
    <div className="pv-chain-wrap">
      <p className="pv-chain-sum t-group">
        {source
          ? `当前生效：${TIER_LABEL[source]}`
          : "没有找到可用凭据，请求会返回 401"}
      </p>
      <ol className="pv-chain" aria-label="凭据查找链">
        {chain.map((t, i) => {
          const effective = t.source === source;
          return (
            <li
              key={t.source}
              className="pv-chain-step t-aux"
              data-effective={effective || undefined}
            >
              <span className="t-mono">{i + 1}</span>
              <span className="t-mono">{TIER_LABEL[t.source]}</span>
              <span className="pv-chain-d t-mono">{t.detail ?? ""}</span>
              {effective ? (
                <Chip tone="live">生效</Chip>
              ) : t.hit ? (
                <Chip>已设置</Chip>
              ) : (
                <span className="t-aux">未设置</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** 连接里的「凭据来源」一行：当前生效的是哪一层，点开看四层的查找顺序。 */
export function CredentialSource({ p }: { p: ProviderView }) {
  const [open, setOpen] = useState(false);
  const { source, detail } = p.credential;
  return (
    <SettingRow
      label="凭据来源"
      description="按优先级取第一个能用的：运行时参数、auth.json 与密码库、models.json、环境变量"
    >
      <div className="pv-ctl pv-ctl-end">
        <span className="t-aux" data-tone={source ? undefined : "danger"}>
          {source
            ? `${TIER_LABEL[source]}${detail ? ` · ${detail}` : ""}`
            : "没有找到可用凭据"}
        </span>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          查看顺序
        </Button>
      </div>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title="凭据解析顺序"
          description="从高到低，第一个能解析的来源生效"
          footer={
            <Button variant="primary" onClick={() => setOpen(false)}>
              完成
            </Button>
          }
        >
          <CredentialChain p={p} />
        </Modal>
      )}
    </SettingRow>
  );
}
