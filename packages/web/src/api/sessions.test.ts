import { afterEach, expect, test, vi } from "vitest";
import { getUserMessages } from "./sessions";

afterEach(() => vi.unstubAllGlobals());

const entry = (i: number, timestamp: string | null = null) => ({
  entryId: `e${i}`,
  text: `指令 ${i}`,
  timestamp,
});

test("指令列表：带令牌请求当前分支的 user-messages，形状不合法的项被丢弃", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          messages: [
            entry(0, "2026-10-27T10:00:00.000Z"),
            { entryId: "bad" },
            "nope",
            entry(1),
          ],
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const r = await getUserMessages("s 1", "tok");
  expect(r).toEqual({
    ok: true,
    data: [
      { entryId: "e0", text: "指令 0", timestamp: "2026-10-27T10:00:00.000Z" },
      { entryId: "e1", text: "指令 1", timestamp: null },
    ],
  });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/api/v1/sessions/s%201/user-messages");
  expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
});

test("指令列表返回体不是数组时算失败，不把脏数据带进界面", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: null }), { status: 200 }),
    ),
  );
  expect(await getUserMessages("s1", null)).toEqual({
    ok: false,
    kind: "server",
  });
});
