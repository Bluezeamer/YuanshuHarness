import { useState } from "react";
import type { Credential } from "../../../api/connections";
import {
  Button,
  Chip,
  ConfirmDialog,
  Empty,
  Field,
  FormDialog,
  Input,
  Menu,
  Table,
  Td,
  Textarea,
  Th,
  toast,
} from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { copyText } from "./actions";
import type { RemoteStore } from "./store";

const names = (list: Credential["referencedBy"]) =>
  list.map((r) => `「${r.label}」`).join("、");

function ImportDialog({
  store,
  onClose,
}: {
  store: RemoteStore;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [pem, setPem] = useState("");
  const [errors, setErrors] = useState<{ name?: string; pem?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErrors({});
    setFormError(null);
    setBusy(true);
    const r = await store.addKey(name.trim(), pem);
    setBusy(false);
    if (r.ok) return onClose();
    if (r.code === "name_exists") setErrors({ name: r.message });
    else if (r.code === "invalid_value") setErrors({ pem: r.message });
    else setFormError(r.message);
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title="导入私钥"
      description="私钥只保存在服务端，加密存放，导入后不再显示。"
      confirmLabel="导入并保存"
      canSubmit={name.trim() !== "" && pem.trim() !== ""}
      busy={busy}
      error={formError}
      onSubmit={() => void submit()}
    >
      <Field label="名称" error={errors.name}>
        {(ctl) => (
          <Input
            {...ctl}
            autoFocus
            autoComplete="off"
            placeholder="例如 ys-deploy-ed25519"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="私钥"
        hint="OpenSSH 或 PEM 格式的无口令私钥全文；服务端暂不支持生成密钥，请先在本机用 ssh-keygen 生成。"
        error={errors.pem}
      >
        {(ctl) => (
          <Textarea
            {...ctl}
            mono
            rows={7}
            spellCheck={false}
            autoComplete="off"
            value={pem}
            onChange={(e) => setPem(e.target.value)}
          />
        )}
      </Field>
    </FormDialog>
  );
}

/** 密钥页：只列 ssh_key；密码跟着各自的连接，不在这里出现。 */
export function KeysTab({
  keys,
  store,
}: {
  keys: readonly Credential[];
  store: RemoteStore;
}) {
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const list = keys.filter((k) => k.kind === "ssh_key");

  const closeRemove = () => {
    setRemoving(null);
    setRemoveError(null);
  };
  const remove = async (k: Credential) => {
    setBusy(true);
    const r = await store.removeKey(k.id);
    setBusy(false);
    if (!r.ok) return setRemoveError(r.message);
    closeRemove();
    toast(`已删除「${k.name}」`, { tone: "ok" });
  };

  return (
    <>
      <div className="st-rc-bar">
        <p className="t-aux">
          私钥由服务端加密保存，不出服务端；删除密钥不会清理远端{" "}
          <span className="t-mono">authorized_keys</span>。
        </p>
        <Button
          variant="outline"
          icon={<PlusIcon size={12} />}
          onClick={() => setImporting(true)}
        >
          导入私钥
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty
          title="密钥库是空的"
          description="导入一把私钥，新建连接时就能选择它。服务端暂不支持生成密钥。"
        />
      ) : (
        <Table caption="密钥" widths={["26%", "18%", "34%", "16%", "6%"]}>
          <thead>
            <tr>
              <Th>名称</Th>
              <Th>类型</Th>
              <Th>指纹</Th>
              <Th>引用</Th>
              <Th>
                <span className="sr-only">操作</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {list.map((k) => {
              const used = k.referencedBy;
              return (
                <tr key={k.id}>
                  <Td truncate>
                    <span className="t-entry">{k.name}</span>
                  </Td>
                  <Td>
                    {k.fingerprint ? (
                      <Chip>{k.keyType ?? "未知"}</Chip>
                    ) : (
                      <Chip
                        tone="warn"
                        title="带口令或格式不认识：服务端解析不了公钥"
                      >
                        不可读
                      </Chip>
                    )}
                  </Td>
                  <Td truncate mono title={k.fingerprint ?? undefined}>
                    {k.fingerprint ?? "—"}
                  </Td>
                  <Td mono title={used.length > 0 ? names(used) : undefined}>
                    {used.length} 条连接
                  </Td>
                  <Td align="end">
                    <Menu
                      label={`${k.name} 的操作`}
                      items={[
                        ...(k.fingerprint
                          ? [
                              {
                                id: "copy",
                                label: "复制指纹",
                                onSelect: () =>
                                  void copyText(
                                    k.fingerprint ?? "",
                                    "已复制指纹",
                                  ),
                              },
                            ]
                          : []),
                        {
                          id: "remove",
                          label: "删除密钥",
                          tone: "danger" as const,
                          separatorBefore: k.fingerprint !== null,
                          disabled: used.length > 0,
                          ...(used.length > 0
                            ? { hint: `被 ${used.length} 条连接使用` }
                            : {}),
                          onSelect: () => setRemoving(k),
                        },
                      ]}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {importing && (
        <ImportDialog store={store} onClose={() => setImporting(false)} />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `删除「${removing.name}」` : ""}
        confirmLabel="删除"
        busy={busy}
        error={removeError}
        onClose={closeRemove}
        onConfirm={() => removing && void remove(removing)}
      >
        私钥会从服务端移除；已加入远端 authorized_keys 的公钥不会自动撤销。
      </ConfirmDialog>
    </>
  );
}
