import type net from "node:net";

// 每个设备已打开的底层连接：HTTP keep-alive 的连接、以及 WebSocket 升级之后仍是的那个 socket。
// 撤销设备时一并掐断，手机上的界面不会一直挂着一个已经没权限的连接。
export class DeviceConnections {
  private readonly sockets = new Map<string, Set<net.Socket>>();

  track(deviceId: string, socket: net.Socket): void {
    let set = this.sockets.get(deviceId);
    if (!set) {
      set = new Set();
      this.sockets.set(deviceId, set);
    }
    // 同一个 socket 只登记一次，否则会重复挂 close 监听
    if (set.has(socket)) return;
    set.add(socket);
    socket.once("close", () => {
      const live = this.sockets.get(deviceId);
      if (!live) return;
      live.delete(socket);
      if (live.size === 0) this.sockets.delete(deviceId);
    });
  }

  /** 掐断这个设备的全部连接，返回掐断的数量。 */
  disconnect(deviceId: string): number {
    const set = this.sockets.get(deviceId);
    if (!set) return 0;
    this.sockets.delete(deviceId);
    for (const socket of set) socket.destroy();
    return set.size;
  }
}
