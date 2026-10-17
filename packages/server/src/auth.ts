import net from "node:net";

export interface Cidr {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

// 前缀只接受十进制数字，不接受符号、空白或前导加号。
export function parseCidr(raw: string): Cidr | undefined {
  const m = /^([^/]+)\/([0-9]{1,3})$/.exec(raw);
  if (!m) return undefined;
  const [, address, p] = m as unknown as [string, string, string];
  const kind = net.isIP(address);
  if (kind === 0) return undefined;
  const prefix = Number(p);
  const family = kind === 4 ? "ipv4" : "ipv6";
  if (prefix > (kind === 4 ? 32 : 128)) return undefined;
  return { address, prefix, family };
}

export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,}$/;
