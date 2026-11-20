import { expect, test } from "vitest";
import type { Tab } from "../../features/workspace/model/types";
import { formatRoute, parseRoute, type Route } from "./route";

const roundTrip = (r: Route) => parseRoute(formatRoute(r));

test("列表、对话、设置：格式化后能原样解析回来", () => {
  expect(formatRoute({ name: "list" })).toBe("/m/");
  expect(formatRoute({ name: "chat", sid: "s1" })).toBe("/m/s/s1");
  expect(formatRoute({ name: "settings" })).toBe("/m/settings");
  for (const r of [
    { name: "list" },
    { name: "chat", sid: "s 1/x" },
    { name: "settings" },
  ] satisfies Route[])
    expect(roundTrip(r)).toEqual(r);
});

test("弹层是同一页加 ?layer=，未知的弹层名忽略", () => {
  expect(formatRoute({ name: "list", layer: "new" })).toBe("/m/?layer=new");
  expect(roundTrip({ name: "chat", sid: "s1", layer: "status" })).toEqual({
    name: "chat",
    sid: "s1",
    layer: "status",
  });
  expect(parseRoute("/m/?layer=nope")).toEqual({ name: "list" });
});

test("列表上的弹层带 target，对话有审计视图；target 与 audit 经 URL 往返不丢", () => {
  const tools: Route = { name: "list", layer: "tools", target: "w 1" };
  expect(formatRoute(tools)).toBe("/m/?layer=tools&target=w+1");
  expect(roundTrip(tools)).toEqual(tools);
  const audit: Route = { name: "chat", sid: "s1", audit: true };
  expect(formatRoute(audit)).toBe("/m/s/s1?audit=1");
  expect(roundTrip(audit)).toEqual(audit);
  expect(roundTrip({ name: "chat", sid: "s1" })).toEqual({
    name: "chat",
    sid: "s1",
  });
});

test("标签页：各类标签的字段经 URL 往返不丢，弹层也能叠上去", () => {
  const tabs: Tab[] = [
    { id: "m-sub", type: "sub", sid: "s1", sub: "e1" },
    { id: "m-job", type: "job", sid: "s1", job: "j1" },
    { id: "m-files", type: "files", host: "server", path: "/a/b c" },
    { id: "m-term", type: "term", host: "dev", cwd: "/w", termId: "t1" },
    { id: "m-web", type: "web", page: "p1" },
    {
      id: "m-canvas",
      type: "canvas",
      host: "server",
      path: "/w",
      canvas: "草图",
    },
    {
      id: "m-preview",
      type: "preview",
      host: "server",
      path: "/a.ts",
      sid: "s1",
      diff: { turn: 3, path: "/a.ts" },
    },
    {
      id: "m-preview",
      type: "preview",
      host: "server",
      sid: "s1",
      diff: { turn: null, path: "src/x.ts", team: true },
    },
  ];
  for (const tab of tabs)
    expect(roundTrip({ name: "tab", tab })).toEqual({ name: "tab", tab });
  const withLayer: Route = {
    name: "tab",
    tab: { id: "m-web", type: "web", page: "p1" },
    layer: "tools",
  };
  expect(roundTrip(withLayer)).toEqual(withLayer);
});

test("不认识的路径与标签类型回列表", () => {
  expect(parseRoute("/m/nowhere")).toEqual({ name: "list" });
  expect(parseRoute("/m/t/unknown?path=/a")).toEqual({ name: "list" });
  expect(parseRoute("/anything")).toEqual({ name: "list" });
});
