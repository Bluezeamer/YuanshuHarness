// 设备令牌：手机端用配对码换一个独立的设备令牌，之后用它访问全部接口。
// 与服务端 packages/server/src/api/devices.ts 对应。
import { call, get } from "./http";

export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 用配对码换设备令牌（公开接口，不带令牌）；码无效是 401，来源被限流是 429 */
export const pairDevice = (code: string, name: string) =>
  call(
    "POST",
    "/api/v1/devices/pair",
    null,
    { code, name },
    (b: { token: string; device: DeviceView }) => b,
  );

export type Whoami =
  | { kind: "global" }
  | { kind: "device"; device: DeviceView };

export const whoami = (token: string | null) =>
  get("/api/v1/auth/whoami", token, (b: Whoami) => b);

/** 设备退出自己：服务端删掉这条设备，令牌随即失效 */
export const removeSelf = (token: string | null) =>
  call("DELETE", "/api/v1/devices/self", token, undefined, () => undefined);

/** 桌面（全局令牌）建一个配对码：5 分钟有效、一次性 */
export const createPairing = (token: string | null) =>
  call(
    "POST",
    "/api/v1/devices/pairing",
    token,
    undefined,
    (b: { code: string; expiresAt: string }) => b,
  );

export const listDevices = (token: string | null) =>
  get("/api/v1/devices", token, (b: { devices: DeviceView[] }) => b.devices);

export const removeDevice = (token: string | null, id: string) =>
  call(
    "DELETE",
    `/api/v1/devices/${encodeURIComponent(id)}`,
    token,
    undefined,
    () => undefined,
  );
