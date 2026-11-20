// git 状态的形状校验与「仓库根 + 相对路径 → 绝对路径」映射
import { expect, test, vi } from "vitest";
import { EMPTY_GIT, gitStatus, statusByPath } from "./git";

const fetchOnce = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

test("statusByPath：拼成绝对路径，root 为 null 时为空表", () => {
  const m = statusByPath({
    root: "/repo",
    branch: "main",
    detached: false,
    truncated: false,
    entries: [
      { path: "a.ts", status: "modified" },
      { path: "src/b.ts", status: "untracked" },
    ],
  });
  expect(m.get("/repo/a.ts")).toBe("modified");
  expect(m.get("/repo/src/b.ts")).toBe("untracked");
  expect(statusByPath(EMPTY_GIT).size).toBe(0);
});

test("gitStatus：坏字段退化为空状态，非仓库保留 root: null", async () => {
  vi.stubGlobal(
    "fetch",
    fetchOnce({
      root: null,
      branch: null,
      detached: false,
      entries: [],
      truncated: false,
    }),
  );
  const r = await gitStatus("tok", "local", "/tmp");
  expect(r.ok && r.data.root).toBeNull();
  expect(r.ok && r.data.entries).toEqual([]);
  vi.unstubAllGlobals();
});
