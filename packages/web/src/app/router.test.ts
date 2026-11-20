import { expect, test } from "vitest";
import { parseRoute } from "./router";

test("parseRoute：各路径与尾斜杠、编码的 id、未知路径", () => {
  expect(parseRoute("/")).toEqual({ name: "workspace" });
  expect(parseRoute("/capabilities/")).toEqual({ name: "capabilities" });
  expect(parseRoute("/settings")).toEqual({ name: "settings" });
  expect(parseRoute("/settings/providers/")).toEqual({
    name: "settings",
    page: "providers",
  });
  expect(parseRoute("/settings/a/b")).toEqual({ name: "notfound" });
  expect(parseRoute("/preview")).toEqual({ name: "preview" });
  expect(parseRoute("/sessions/a%2F1")).toEqual({
    name: "session",
    id: "a/1",
  });
  expect(parseRoute("/sessions/")).toEqual({ name: "notfound" });
  expect(parseRoute("/nope")).toEqual({ name: "notfound" });
});
