import { useState } from "react";
import {
  type AuthMethod,
  type KeyStorage,
  type ProviderCompat,
  type ProviderView,
  THINKING_FORMATS,
} from "../../../api/providers";
import {
  Button,
  FormDialog,
  Input,
  Modal,
  Segmented,
  Select,
  SettingRow,
  SummaryRow,
  Tri,
  type TriValue,
} from "../../../ui";
import { notify } from "../frame/notify";
import type { SectionProps } from "./ConnectionSection";
import { ModelsJsonPane } from "./ModelsJsonPane";
import { primaryOf, STORAGE_LABEL } from "./model";
import type { ProvidersStore } from "./store";

const KEY_SOURCES = [
  { value: "key", label: "直接填写" },
  { value: "env", label: "读环境变量" },
  { value: "cmd", label: "运行命令取得" },
] as const;

type KeyWay = "key" | "env" | "cmd";

// 这些项填错时，高级区不能收起来，免得错误藏在看不见的地方
const ADVANCED_FIELDS = [
  "slug",
  "envVariable",
  "command",
  "maxConcurrent",
] as const;

const triOf = (v: boolean | undefined): TriValue =>
  v === undefined ? "auto" : v ? "on" : "off";
const fromTri = (v: TriValue): boolean | undefined =>
  v === "auto" ? undefined : v === "on";

// 协议兼容：默认按端点 URL 自动推断，仅在请求报错时覆盖。弹窗自带提交（操作，不进页面草稿）。
function CompatDialog({
  p,
  store,
  onClose,
}: {
  p: ProviderView;
  store: ProvidersStore;
  onClose: () => void;
}) {
  const [compat, setCompat] = useState<ProviderCompat>(p.compat ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ProviderCompat>) =>
    setCompat((cur) => {
      const next = { ...cur, ...patch };
      // 三态里“自动”= 键缺省
      for (const k of Object.keys(next) as (keyof ProviderCompat)[])
        if (next[k] === undefined) delete next[k];
      return next;
    });
  const changed = JSON.stringify(compat) !== JSON.stringify(p.compat ?? {});

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await store.update(p.id, () => ({ compat }));
    setBusy(false);
    if (!r.ok) return setError(r.message);
    notify(null, "已保存");
    onClose();
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title="协议兼容"
      description="默认按端点 URL 自动推断；仅在请求报错时覆盖，错误的兼容项比缺失更难排查"
      confirmLabel="保存"
      canSubmit={changed}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <SettingRow label="developer 角色" description="system 还是 developer">
        <Tri
          aria-label="developer 角色"
          value={triOf(compat.supportsDeveloperRole)}
          onChange={(v) => set({ supportsDeveloperRole: fromTri(v) })}
        />
      </SettingRow>
      <SettingRow
        label="max tokens 字段"
        description="部分端点只接受 max_tokens"
      >
        {(c) => (
          <Select
            {...c}
            value={compat.maxTokensField ?? ""}
            options={[
              { value: "", label: "自动推断" },
              { value: "max_tokens", label: "max_tokens" },
              {
                value: "max_completion_tokens",
                label: "max_completion_tokens",
              },
            ]}
            onChange={(v) =>
              set({
                maxTokensField:
                  (v as ProviderCompat["maxTokensField"]) || undefined,
              })
            }
          />
        )}
      </SettingRow>
      <SettingRow label="reasoning_effort" description="是否接受思考强度参数">
        <Tri
          aria-label="reasoning_effort"
          value={triOf(compat.supportsReasoningEffort)}
          onChange={(v) => set({ supportsReasoningEffort: fromTri(v) })}
        />
      </SettingRow>
      <SettingRow
        label="思考转文本"
        description="拒绝 thinking block 的端点：把历史里的思考内容当普通文本发回"
      >
        <Tri
          aria-label="思考转文本"
          value={triOf(compat.requiresThinkingAsText)}
          onChange={(v) => set({ requiresThinkingAsText: fromTri(v) })}
        />
      </SettingRow>
      <SettingRow
        label="思考参数格式"
        description="thinkingFormat：思考开关与强度在请求里的写法"
      >
        {(c) => (
          <Select
            {...c}
            value={compat.thinkingFormat ?? ""}
            options={[
              { value: "", label: "自动推断" },
              ...THINKING_FORMATS.map((f) => ({ value: f, label: f })),
            ]}
            onChange={(v) =>
              set({
                thinkingFormat:
                  (v as ProviderCompat["thinkingFormat"]) || undefined,
              })
            }
          />
        )}
      </SettingRow>
    </FormDialog>
  );
}

type Dialog = "compat" | "json" | null;

// 高级：日常不用碰的都在这里，默认折起。这里的项和「连接」一样进页面草稿；两个弹窗是各自的操作。
export function AdvancedSection({
  p,
  store,
  draft,
  errors,
  onChange,
}: SectionProps) {
  const [more, setMore] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const open = more || ADVANCED_FIELDS.some((k) => errors[k]);
  const isKey = primaryOf(draft.method) === "key";
  const way = draft.method as KeyWay;
  const overridden = p.compat ? Object.keys(p.compat).length : 0;

  return (
    <section className="st-block" aria-label="高级">
      <header className="st-block-h t-group">
        <span>高级</span>
        <span className="t-aux">密钥来源、请求头、并发、协议兼容</span>
        <span className="pv-grow" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-label={open ? "收起高级设置" : "展开高级设置"}
          onClick={() => setMore(!open)}
        >
          {open ? "收起" : "展开"}
        </Button>
      </header>
      {open && (
        <>
          {p.custom && (
            <SettingRow
              label="标识"
              description="models.json 的键，命令行用 标识/模型"
              error={errors.slug}
            >
              {(c) => (
                <Input
                  {...c}
                  mono
                  aria-label="标识"
                  value={draft.slug}
                  onChange={(e) => onChange({ slug: e.target.value })}
                />
              )}
            </SettingRow>
          )}
          {isKey && (
            <SettingRow
              label="密钥来源"
              description="API Key 从哪里取：直接填写，或由 Server 主机的环境变量 / 命令提供"
              error={errors.envVariable ?? errors.command}
            >
              {(c) => (
                <div className="pv-ctl">
                  <Select
                    {...c}
                    value={way}
                    options={KEY_SOURCES.map((o) => ({ ...o }))}
                    onChange={(v) => onChange({ method: v as AuthMethod })}
                  />
                  {way === "env" &&
                    (p.custom ? (
                      <Input
                        mono
                        aria-label="环境变量名"
                        placeholder="PROVIDER_API_KEY"
                        value={draft.envVariable}
                        onChange={(e) =>
                          onChange({ envVariable: e.target.value })
                        }
                      />
                    ) : (
                      <span className="t-mono">
                        {p.envVariable
                          ? `$${p.envVariable}`
                          : "由 pi 内置的环境变量决定"}
                      </span>
                    ))}
                  {way === "cmd" && (
                    <Input
                      mono
                      aria-label="取密钥命令"
                      placeholder="security find-generic-password -ws anthropic"
                      value={draft.command}
                      onChange={(e) => onChange({ command: e.target.value })}
                    />
                  )}
                </div>
              )}
            </SettingRow>
          )}
          {draft.method === "key" && (
            <SettingRow
              label="保存位置"
              description={
                draft.keyStorage === "session"
                  ? "密钥只存在于本次进程内存，元枢重启后需要重新输入"
                  : "加密保存在元枢的密码库，会话运行时才注入给 pi"
              }
            >
              <Segmented
                aria-label="密钥保存位置"
                size="sm"
                value={draft.keyStorage}
                onChange={(s: KeyStorage) => onChange({ keyStorage: s })}
                options={(["auth", "session"] as const).map((s) => ({
                  value: s,
                  label: STORAGE_LABEL[s] ?? s,
                }))}
              />
            </SettingRow>
          )}
          {p.custom && (
            <SettingRow
              label="鉴权头"
              description="留空则按协议默认：Bearer / x-api-key。写成「头名」或「头名: 前缀」，密钥拼在后面"
            >
              {(c) => (
                <Input
                  {...c}
                  mono
                  aria-label="鉴权头"
                  placeholder="Authorization: Bearer"
                  value={draft.authHeader}
                  onChange={(e) => onChange({ authHeader: e.target.value })}
                />
              )}
            </SettingRow>
          )}
          <SettingRow
            label="最大并发请求数"
            description="同一时刻发给它的请求上限（默认 50），超了在服务端排队、不会报错。本地部署的模型按它自己的上限填，如 2"
            error={errors.maxConcurrent}
          >
            {(c) => (
              <Input
                {...c}
                mono
                inputMode="numeric"
                aria-label="最大并发请求数"
                placeholder="50"
                value={draft.maxConcurrent}
                onChange={(e) => onChange({ maxConcurrent: e.target.value })}
              />
            )}
          </SettingRow>
          {p.custom && (
            <SummaryRow
              label="协议兼容"
              value={overridden ? `已覆盖 ${overridden} 项` : "全部自动"}
              note="端点报错时再调"
              onOpen={() => setDialog("compat")}
            />
          )}
          <SummaryRow
            label="将生成的 models.json"
            value="查看预览"
            note="只读，不写盘"
            onOpen={() => setDialog("json")}
          />
        </>
      )}

      {dialog === "compat" && (
        <CompatDialog p={p} store={store} onClose={() => setDialog(null)} />
      )}
      {dialog === "json" && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title="models.json 预览"
          size="lg"
          footer={
            <Button variant="primary" onClick={() => setDialog(null)}>
              完成
            </Button>
          }
        >
          <ModelsJsonPane />
        </Modal>
      )}
    </section>
  );
}
