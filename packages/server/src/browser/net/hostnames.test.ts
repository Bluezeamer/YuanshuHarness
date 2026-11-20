import { expect, test } from "vitest";
import {
  envIdOfLabel,
  fileUrl,
  hostLabel,
  parseVirtualHost,
  serviceHost,
} from "./hostnames.js";

const UUID = "0199c3e1-7a2b-7c4d-8e9f-0123456789ab";

test("hostLabel：本机用 server，其余环境 id 原样", () => {
  expect(hostLabel("local")).toBe("server");
  expect(hostLabel(UUID)).toBe(UUID);
  expect(envIdOfLabel("server")).toBe("local");
  expect(envIdOfLabel(UUID)).toBe(UUID);
});

test("serviceHost 与 fileUrl 用同一套标签", () => {
  expect(serviceHost("local", 3000)).toBe("server.localhost:3000");
  expect(serviceHost(UUID, 80)).toBe(`${UUID}.localhost:80`);
  expect(fileUrl("local", "/tmp/a b.html")).toBe(
    "http://server.files.localhost/tmp/a%20b.html",
  );
  expect(fileUrl(UUID, "/w/x/y.html")).toBe(
    `http://${UUID}.files.localhost/w/x/y.html`,
  );
  // 路径里的 `?` `#` 必须编码，否则会被当成查询与锚点
  expect(fileUrl("local", "/w/a?b#c")).toBe(
    "http://server.files.localhost/w/a%3Fb%23c",
  );
});

test("parseVirtualHost：服务、文件、其他", () => {
  expect(parseVirtualHost("server.localhost")).toEqual({
    kind: "service",
    envId: "local",
  });
  expect(parseVirtualHost("SERVER.LOCALHOST.")).toEqual({
    kind: "service",
    envId: "local",
  });
  expect(parseVirtualHost("server.files.localhost")).toEqual({
    kind: "file",
    envId: "local",
  });
  expect(parseVirtualHost(`${UUID}.localhost`)).toEqual({
    kind: "service",
    envId: UUID,
  });
  expect(parseVirtualHost(`${UUID}.FILES.localhost`)).toEqual({
    kind: "file",
    envId: UUID,
  });
  expect(parseVirtualHost("localhost")).toBeNull();
  expect(parseVirtualHost("example.com")).toBeNull();
  expect(parseVirtualHost("a.b.files.localhost")).toBeNull();
  expect(parseVirtualHost(".localhost")).toBeNull();
});
