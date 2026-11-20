// 画面流的对外入口：中枢与协议。
export {
  type Attachment,
  StreamHub,
  type StreamHubDeps,
  type Viewer,
} from "./hub.js";
export {
  type ClientMessage,
  FRAME_OPTS,
  parseClientMessage,
  type StreamEvent,
} from "./protocol.js";
