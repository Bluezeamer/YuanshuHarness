import { expect, test, vi } from "vitest";
import { autoCheckUpdates } from "./autoCheck";

const HOUR = 3600_000;
const ok = { checked: 2, failed: [] };

test("6 小时内查过不再查，过了才再查；两类各记各的", async () => {
  const run = vi.fn().mockResolvedValue(ok);
  await autoCheckUpdates("skills", run, 1000);
  await autoCheckUpdates("skills", run, 1000 + 5 * HOUR);
  expect(run).toHaveBeenCalledTimes(1);
  await autoCheckUpdates("skills", run, 1000 + 7 * HOUR);
  expect(run).toHaveBeenCalledTimes(2);
  await autoCheckUpdates("mcp", run, 1000 + 7 * HOUR);
  expect(run).toHaveBeenCalledTimes(3);
});

test("全都没查到或没有可查的，不记时间，下次进来再试", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ checked: 2, failed: ["a", "b"] })
    .mockResolvedValueOnce({ checked: 0, failed: [] })
    .mockResolvedValue({ checked: 2, failed: ["a"] });
  await autoCheckUpdates("mcp", run, 1000);
  await autoCheckUpdates("mcp", run, 2000);
  await autoCheckUpdates("mcp", run, 3000);
  expect(run).toHaveBeenCalledTimes(3);
  // 部分成功就算查过
  await autoCheckUpdates("mcp", run, 4000);
  expect(run).toHaveBeenCalledTimes(3);
});
