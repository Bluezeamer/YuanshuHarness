import { afterEach, expect, test, vi } from "vitest";
import { listDirectories } from "./directories";

afterEach(() => vi.unstubAllGlobals());

const ws = (id: string) => ({
  id,
  name: id,
  path: `/w/${id}`,
  environmentId: "local",
  tier: "rules",
  createdAt: "2026-10-27T00:00:00.000Z",
});

test("目录列表过滤掉会话附件内部目录（id=attachment）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ directories: [ws("w1"), ws("attachment")] }),
          { status: 200 },
        ),
    ),
  );
  const r = await listDirectories("tok");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.data.map((w) => w.id)).toEqual(["w1"]);
});
