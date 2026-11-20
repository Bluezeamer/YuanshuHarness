import { expect, test } from "vitest";
import type { ConnectionList, ConnectionView } from "../../api/connections";
import { environmentIdOf, hostIdOf, hostsOf } from "./hosts";

const conn = (id: string, status: ConnectionView["status"]) =>
  ({ id, label: `连接 ${id}`, status }) as ConnectionView;

test("主机 id 与环境 id 互译：local ⇄ server，其余原样", () => {
  expect(hostIdOf("local")).toBe("server");
  expect(hostIdOf(null)).toBe("server");
  expect(hostIdOf(undefined)).toBe("server");
  expect(hostIdOf("gpu")).toBe("gpu");
  expect(environmentIdOf("server")).toBe("local");
  expect(environmentIdOf("gpu")).toBe("gpu");
  for (const id of ["server", "gpu"])
    expect(hostIdOf(environmentIdOf(id))).toBe(id);
});

test("主机清单：Server 本机恒在，只列已激活的连接", () => {
  const list = {
    server: { host: "h", environmentId: "local", label: "构建机" },
    connections: [
      conn("a", "active"),
      conn("b", "inactive"),
      conn("c", "verify-required"),
      conn("d", "activating"),
    ],
  } as ConnectionList;
  expect(hostsOf(list)).toEqual([
    { id: "server", name: "构建机" },
    { id: "a", name: "连接 a" },
  ]);
  expect(hostsOf(null)).toEqual([{ id: "server", name: "Server" }]);
});
