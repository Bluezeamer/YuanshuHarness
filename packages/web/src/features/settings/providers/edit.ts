import type {
  AuthMethod,
  KeyStorage,
  ProviderApi,
  ProviderView,
  UpdateProviderInput,
} from "../../../api/providers";
import { codeText } from "./errors";
import { type Primary, primaryOf, SLUG_RE } from "./model";

/**
 * 供应商详情里能编辑的字段：页面上改了先进草稿，点保存才写（ys-ui-design 的 X06）。
 * 数字、可清空的项都存成用户敲的文字，保存时才校验、换算。
 */
export interface Editable {
  name: string;
  api: string;
  baseUrl: string;
  method: AuthMethod;
  envVariable: string;
  command: string;
  slug: string;
  authHeader: string;
  keyStorage: KeyStorage;
  maxConcurrent: string;
}

export const editableOf = (p: ProviderView): Editable => ({
  name: p.name,
  api: p.api ?? "",
  baseUrl: p.baseUrl ?? "",
  method: p.method,
  envVariable: p.envVariable ?? "",
  command: p.command ?? "",
  slug: p.slug ?? "",
  authHeader: p.authHeader ?? "",
  keyStorage: p.keyStorage,
  maxConcurrent: String(p.maxConcurrent),
});

export type EditErrors = Partial<Record<keyof Editable, string>>;

const MAX_CONCURRENT = 1000;

/** 能在页面上就拦下的填写问题；其余（地址格式、鉴权头写法等）交给服务端，文案同一套。 */
export function validateEdit(d: Editable, p: ProviderView): EditErrors {
  const out: EditErrors = {};
  if (p.custom) {
    if (d.name.trim() === "") out.name = codeText("invalid_name");
    if (!SLUG_RE.test(d.slug.trim())) out.slug = codeText("invalid_slug");
    if (d.method === "env" && d.envVariable.trim() === "")
      out.envVariable = codeText("env_variable_required");
  }
  if (d.method === "cmd" && d.command.trim() === "")
    out.command = codeText("command_required");
  const t = d.maxConcurrent.trim();
  const n = Number(t);
  if (!(t !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENT))
    out.maxConcurrent = `要是 1 到 ${MAX_CONCURRENT} 的整数，默认 50`;
  return out;
}

/** 切登录方式：回到 API Key 一类时，原来就是 env / cmd 的话还回到原来那个。 */
export function withPrimary(
  d: Editable,
  p: ProviderView,
  to: Primary,
): Editable {
  if (primaryOf(d.method) === to) return d;
  const back = primaryOf(p.method) === "key" ? p.method : "key";
  return { ...d, method: to === "key" ? back : to };
}

const orNull = (v: string): string | null =>
  v.trim() === "" ? null : v.trim();

/** 只带与已保存值不同的项；键入的新 API Key 另算，非空才发。调用前要先过 validateEdit。 */
export function patchOf(
  d: Editable,
  p: ProviderView,
  apiKey: string,
): UpdateProviderInput {
  const s = editableOf(p);
  const out: UpdateProviderInput = {};
  if (d.name !== s.name) out.name = d.name.trim();
  if (d.api !== s.api) out.api = d.api as ProviderApi;
  if (d.baseUrl !== s.baseUrl)
    out.baseUrl = p.custom ? d.baseUrl.trim() : orNull(d.baseUrl);
  if (d.method !== s.method) out.method = d.method;
  if (d.envVariable !== s.envVariable) out.envVariable = orNull(d.envVariable);
  if (d.command !== s.command) out.command = orNull(d.command);
  if (d.slug !== s.slug) out.slug = d.slug.trim();
  if (d.authHeader !== s.authHeader) out.authHeader = orNull(d.authHeader);
  if (d.keyStorage !== s.keyStorage) out.keyStorage = d.keyStorage;
  if (d.maxConcurrent !== s.maxConcurrent)
    out.maxConcurrent = Number(d.maxConcurrent.trim());
  // 来源改成 env / cmd 后，之前键入的密钥不再有去处
  if (apiKey !== "" && primaryOf(d.method) === "key") out.apiKey = apiKey;
  return out;
}
