import { enc, request } from "./http";

// pi 扩展包：与服务端 api/plugins.ts、plugins/runtime.ts 对应。
// 登记写在 pi 自己的 settings.json（不建表），所以没有 id：source 是 pi 规范化后的来源原文，开关与卸载都用它。

export interface PluginView {
  /** pi 登记里的来源原文；本地路径会被规范化成相对写法。 */
  source: string;
  /** 包自己 package.json 里的版本；读不到为 null。 */
  version: string | null;
  /** 整包开关：关闭即不加载它的扩展。 */
  enabled: boolean;
  /** 包体是否已就位（登记了但没装上时为 false）。 */
  installed: boolean;
  extensionCount: number;
  skillCount: number;
}

export interface PluginPreview {
  source: string;
  version: string | null;
  extensionCount: number;
  skillCount: number;
  /** 包带安装脚本：默认不跑，用户显式允许才跑。 */
  hasInstallScript: boolean;
}

const base = "/api/v1/plugins";
const one = (source: string) => `${base}/${enc(source)}`;

export const listPlugins = (token: string | null) =>
  request<PluginView[]>("GET", base, token);

/** 临时装一份看内容，不改登记；来源里没有可加载的内容是 422 source_empty。 */
export const previewPlugin = (token: string | null, source: string) =>
  request<PluginPreview>("POST", `${base}/preview`, token, { source });

export const installPlugin = (
  token: string | null,
  source: string,
  allowScript: boolean,
) => request("POST", base, token, { source, allowScript });

export const uninstallPlugin = (token: string | null, source: string) =>
  request("DELETE", one(source), token);

export const setPluginEnabled = (
  token: string | null,
  source: string,
  enabled: boolean,
) => request("PATCH", one(source), token, { enabled });
