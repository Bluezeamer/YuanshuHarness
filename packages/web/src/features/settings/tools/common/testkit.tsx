// 仅测试使用：三个页签共用的假 fetch 底座与挂载辅助。
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ToastHost } from "../../../../ui";
import { ToolsPage } from "../ToolsPage";
import { markUpdatesChecked } from "./autoCheck";

export const reply = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** 一个路由：返回 undefined 表示不处理，交给下一个。 */
export type Route = (
  method: string,
  path: string,
  body: unknown,
) => Response | Promise<Response> | undefined;

/** 把若干路由拼成 fetch 假实现，记录所有调用；没有路由命中返回 404。 */
export function fakeFetch(...routes: Route[]) {
  const calls: Call[] = [];
  // 测试用的临时覆盖，先于正式路由命中
  const overrides: Route[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: input, body });
    for (const r of [...overrides, ...routes]) {
      const res = r(method, input, body);
      if (res) return res;
    }
    return reply(404, { error: "not_found" });
  });
  return {
    fetchMock,
    calls,
    override: (r: Route) => overrides.unshift(r),
    writes: () => calls.filter((c) => c.method !== "GET"),
    called: (method: string, pathRe: RegExp) =>
      calls.filter((c) => c.method === method && pathRe.test(c.path)),
  };
}

export type Fake = ReturnType<typeof fakeFetch>;

/**
 * 挂载整页并等到页签出现。
 * 默认当作「刚查过新版」：进页签时的后台检查会多发请求，扰乱各用例对请求的计数；要测它就传 autoCheck。
 */
export async function mountPage(
  fake: Fake,
  { autoCheck = false }: { autoCheck?: boolean } = {},
) {
  vi.stubGlobal("fetch", fake.fetchMock);
  if (!autoCheck) {
    markUpdatesChecked("skills");
    markUpdatesChecked("mcp");
  }
  render(
    <>
      <ToolsPage />
      <ToastHost />
    </>,
  );
  await screen.findByRole("tab", { name: /工具/ });
}
