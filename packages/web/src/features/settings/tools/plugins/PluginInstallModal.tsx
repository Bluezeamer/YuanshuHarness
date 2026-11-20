import { useState } from "react";
import type { PluginPreview } from "../../../../api/pluginLibrary";
import {
  Button,
  Checkbox,
  Field,
  InlineNotice,
  Input,
  Modal,
} from "../../../../ui";
import { checkSource, KIND_TEXT, kindOf, nameOf, prefixHint } from "./model";
import type { PluginStore } from "./store";

export interface PluginInstallModalProps {
  store: PluginStore;
  /** 装好后回调，参数是登记里的来源（没认出时为 null）。 */
  onInstalled: (source: string | null, name: string) => void;
  onClose: () => void;
}

// 安装弹窗：两步。先「预览」——临时装一份看里面有什么（不改登记），确认后才正式安装。
// 改了来源，之前的预览就不作数了。带安装脚本的包默认不跑脚本，要用户勾选才允许。
export function PluginInstallModal({
  store,
  onInstalled,
  onClose,
}: PluginInstallModalProps) {
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [allowScript, setAllowScript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checked = checkSource(raw);
  const problem = checked && !checked.ok ? checked.message : null;
  const source = checked?.ok ? checked.source : null;
  const hint = prefixHint(raw);

  const edit = (v: string) => {
    setRaw(v);
    setPreview(null);
    setAllowScript(false);
    setError(null);
  };

  const run = async () => {
    if (source === null) return;
    setBusy(true);
    setError(null);
    if (preview === null) {
      const r = await store.preview(source);
      setBusy(false);
      if (r.ok) setPreview(r.data);
      else setError(r.message);
      return;
    }
    const r = await store.install(source, allowScript);
    setBusy(false);
    if (r.ok) onInstalled(r.data, nameOf(source));
    else setError(r.message);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="安装 pi 扩展"
      description="先预览包里有什么，确认后才安装。装好后只对新会话或重载后的会话生效。"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={source === null}
            onClick={() => void run()}
          >
            {preview === null ? "预览" : "安装"}
          </Button>
        </>
      }
    >
      <div className="st-tl-form">
        <Field
          label="来源"
          hint="npm:包名、git:仓库地址，或本地目录"
          error={problem}
        >
          {(c) => (
            <Input
              {...c}
              value={raw}
              placeholder="npm:@scope/pi-extension"
              spellCheck={false}
              onChange={(e) => edit(e.target.value)}
            />
          )}
        </Field>
        {hint && source !== null && (
          <InlineNotice tone="warn">{hint}</InlineNotice>
        )}

        {preview && (
          <>
            <dl className="st-tl-preview pl-preview" aria-label="预览结果">
              <div>
                <dt className="t-aux">来源类型</dt>
                <dd className="t-mono">{KIND_TEXT[kindOf(preview.source)]}</dd>
              </div>
              <div>
                <dt className="t-aux">版本</dt>
                <dd className="t-mono">
                  {preview.version ? `v${preview.version}` : "无版本"}
                </dd>
              </div>
              <div>
                <dt className="t-aux">带来</dt>
                <dd className="t-mono">
                  {preview.extensionCount} 个扩展 · {preview.skillCount} 个技能
                </dd>
              </div>
            </dl>
            {preview.extensionCount === 0 && (
              <InlineNotice tone="warn">
                这个包里没有扩展，只有技能或其他资源；装上也不会多出工具。
              </InlineNotice>
            )}
            {preview.hasInstallScript && (
              <div className="pl-script">
                <InlineNotice tone="warn">
                  这个包带安装脚本（preinstall / install / postinstall /
                  prepare）。默认不跑，多数包不跑也能用；只有你信任它时才勾选。
                </InlineNotice>
                <Checkbox
                  checked={allowScript}
                  onChange={setAllowScript}
                  aria-label="允许运行安装脚本"
                >
                  <span className="t-plain">允许运行安装脚本</span>
                </Checkbox>
              </div>
            )}
            <p className="st-tl-dim t-aux">
              扩展是可执行的代码，拥有 Server
              进程的全部权限；确认你信任这个来源。
            </p>
          </>
        )}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </div>
    </Modal>
  );
}
