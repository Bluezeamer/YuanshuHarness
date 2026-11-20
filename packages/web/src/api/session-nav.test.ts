import { afterEach, expect, test, vi } from "vitest";
import { getSessionTree, navigateSession } from "./session-nav";

afterEach(() => vi.unstubAllGlobals());

const fetchMock = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const treeBody = {
  leafId: "a1",
  activePath: ["a1", "u1"],
  nodes: [
    {
      id: "u1",
      parentId: null,
      type: "message",
      role: "user",
      preview: "第一轮",
      timestamp: "2026-10-27T10:00:00.000Z",
      children: [
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          role: "assistant",
          preview: "好",
          timestamp: "2026-10-27T10:00:01.000Z",
          children: [],
        },
      ],
    },
  ],
};

test("会话树：带令牌取树，节点按形状校验并保留 children / label", async () => {
  const fetch = fetchMock(treeBody);
  vi.stubGlobal("fetch", fetch);
  const r = await getSessionTree("s 1", "tok");
  expect(r).toEqual({ ok: true, data: treeBody });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/sessions/s%201/tree");
  expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
});

test("会话树：叶子与节点形状不合法时算失败", async () => {
  vi.stubGlobal(
    "fetch",
    fetchMock({ leafId: null, activePath: [], nodes: [{ id: "x" }] }),
  );
  expect(await getSessionTree("s1", null)).toEqual({
    ok: false,
    kind: "server",
  });
});

test("回退：POST entryId，返回 editor（文字 + 附件）与 leafId；409 是 conflict", async () => {
  const attachment = {
    name: "a.png",
    mime: "image/png",
    sizeText: "1 KB",
    path: "a.png",
  };
  const fetch = fetchMock({
    editor: { text: "第二轮", attachments: [attachment] },
    leafId: "a1",
  });
  vi.stubGlobal("fetch", fetch);
  expect(await navigateSession("s1", "u2", "tok")).toEqual({
    ok: true,
    data: {
      editor: { text: "第二轮", attachments: [attachment] },
      leafId: "a1",
    },
  });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/sessions/s1/navigate");
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ entryId: "u2" }));
  expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });

  vi.stubGlobal("fetch", fetchMock({ error: "session_running" }, 409));
  expect(await navigateSession("s1", "u2", "tok")).toEqual({
    ok: false,
    kind: "conflict",
  });
});
