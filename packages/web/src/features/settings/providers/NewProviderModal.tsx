import { useState } from "react";
import {
  KEY_STORAGES,
  type KeyStorage,
  PROVIDER_APIS,
  type ProviderApi,
} from "../../../api/providers";
import {
  Button,
  Field,
  InlineNotice,
  Input,
  Modal,
  Segmented,
  Select,
} from "../../../ui";
import { codeText } from "./errors";
import {
  API_LABEL,
  API_PLACEHOLDER,
  SLUG_RE,
  STORAGE_LABEL,
  slugOf,
} from "./model";
import type { ProvidersStore } from "./store";

type Errors = { name?: string; slug?: string; baseUrl?: string; form?: string };

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// 服务端返回的校验码落到对应字段，其余落到表单底部。
const FIELD_OF: Record<string, keyof Errors> = {
  invalid_name: "name",
  invalid_slug: "slug",
  slug_taken: "slug",
  invalid_base_url: "baseUrl",
};

function Form({
  store,
  onClose,
  onCreated,
}: {
  store: ProvidersStore;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [api, setApi] = useState<ProviderApi>("openai-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyStorage, setKeyStorage] = useState<KeyStorage>("auth");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: Errors = {};
    if (!name.trim()) next.name = codeText("invalid_name");
    if (!SLUG_RE.test(slug)) next.slug = codeText("invalid_slug");
    if (!isHttpUrl(baseUrl.trim())) next.baseUrl = codeText("invalid_base_url");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    const r = await store.create({
      name: name.trim(),
      slug,
      api,
      baseUrl: baseUrl.trim(),
      ...(apiKey ? { apiKey, keyStorage } : {}),
    });
    setBusy(false);
    if (r.ok) {
      onCreated(r.data.id);
      return;
    }
    setErrors({ [(r.code && FIELD_OF[r.code]) || "form"]: r.message });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="添加自定义端点"
      description="OpenAI 兼容 · Responses · Anthropic · Gemini，四种协议任选其一"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
          >
            保存端点
          </Button>
        </>
      }
    >
      <div className="pv-form">
        <Field label="名称" hint="用于会话与审计" error={errors.name}>
          {(c) => (
            <Input
              {...c}
              placeholder="例：团队 vLLM 网关"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugOf(e.target.value));
              }}
            />
          )}
        </Field>
        <Field
          label="标识"
          hint="小写字母、数字、连字符；命令行用 标识/模型"
          error={errors.slug}
        >
          {(c) => (
            <Input
              {...c}
              mono
              placeholder="team-vllm"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="请求协议" hint="决定请求与流式事件的结构">
          {(c) => (
            <Select
              {...c}
              value={api}
              options={PROVIDER_APIS.map((a) => ({
                value: a,
                label: API_LABEL[a],
              }))}
              onChange={(v) => setApi(v as ProviderApi)}
            />
          )}
        </Field>
        <Field
          label="Base URL"
          hint="不含 /chat/completions"
          error={errors.baseUrl}
        >
          {(c) => (
            <Input
              {...c}
              mono
              placeholder={API_PLACEHOLDER[api]}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="API Key"
          hint="可留空：本地端点常不需要；保存后出于安全不再回显"
        >
          {(c) => (
            <Input
              {...c}
              mono
              type="password"
              autoComplete="off"
              placeholder="sk-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
        {apiKey !== "" && (
          <Field label="密钥保存位置">
            <Segmented
              aria-label="密钥保存位置"
              size="sm"
              options={KEY_STORAGES.filter((s) => s !== "models").map((s) => ({
                value: s,
                label: STORAGE_LABEL[s] ?? s,
              }))}
              value={keyStorage}
              onChange={setKeyStorage}
            />
          </Field>
        )}
        {errors.form && (
          <InlineNotice tone="danger">{errors.form}</InlineNotice>
        )}
      </div>
    </Modal>
  );
}

export function NewProviderModal({
  open,
  ...rest
}: {
  open: boolean;
  store: ProvidersStore;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  // 打开时才挂载表单，每次都是干净的草稿
  return open ? <Form {...rest} /> : null;
}
