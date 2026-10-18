import { type ChatConfig, ChatPane } from "./ChatPane";
import { Registry } from "./registry";

export type { ChatConfig } from "./ChatPane";
export { EnvContext } from "./env";

const placeholder = (id: string, displayName: string) => ({
  id,
  displayName,
  configVersion: 1,
  defaultConfig: () => ({}),
  component: () => <p className="p-7 text-mute">尚未可用</p>,
});

export function defaultRegistry(): Registry {
  return new Registry()
    .register<ChatConfig>({
      id: "chat",
      displayName: "对话",
      configVersion: 1,
      defaultConfig: () => ({ sessionId: null }),
      component: ChatPane,
    })
    .register(placeholder("filediscovery", "文件发现"))
    .register(placeholder("terminal", "终端"))
    .register(placeholder("file_preview", "文件预览"))
    .register(placeholder("web_preview", "网页预览"));
}
