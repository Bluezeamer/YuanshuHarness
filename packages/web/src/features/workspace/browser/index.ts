// 工作区浏览器数据层的对外出口：对外只经这里 import。
export type {
  Act,
  ConsoleEntry,
  EngineState,
  ForwardView,
  InputEvent,
  Limits,
  PageView,
  PortView,
} from "../../../api/browser";
export { useInputCapture } from "./inputs";
export type { AgentUse, BrowserState } from "./model";
export { INITIAL_BROWSER } from "./model";
export { acquireBrowserStore, type BrowserStore } from "./store";
export { useBrowser } from "./useBrowser";
export { useForwards } from "./useForwards";
export {
  type PageStreamState,
  type StreamSend,
  usePageStream,
} from "./usePageStream";
export { usePorts } from "./usePorts";
