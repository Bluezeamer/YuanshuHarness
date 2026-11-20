// 出站代理的内网黑名单：浏览器只许访问公网，本工作区的端口与文件走虚拟主机名单独放行。
import net from "node:net";

// 内网、回环、链路本地（含云元数据 169.254.169.254）、Tailscale、NAT64 与保留段：解析出来就不许连。
const RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  // Tailscale / CGNAT：100.64.0.0/10
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["::", 128],
  ["::1", 128],
  // 唯一本地地址：含 Tailscale 的 fd7a:115c:a1e0::/48
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  // NAT64：能映射回内网
  ["64:ff9b::", 96],
];

const list = new net.BlockList();
for (const [address, prefix] of RANGES) {
  list.addSubnet(address, prefix, net.isIPv4(address) ? "ipv4" : "ipv6");
}

/** 该地址是否禁止直连。不是合法 IP 一律当禁止（保守）。 */
export function isBlockedAddress(ip: string): boolean {
  // 去掉 zone id（fe80::1%eth0）
  const address = ip.split("%")[0] as string;
  const kind = net.isIP(address);
  if (kind === 0) return true;
  // BlockList 对 IPv4 映射的 IPv6 地址与 IPv4 规则双向可比（::ffff:127.0.0.1 会命中 127/8）
  return list.check(address, kind === 4 ? "ipv4" : "ipv6");
}
