import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useDraft } from "./useDraft";

const make = (initial: { v: string }) =>
  renderHook(({ saved }) => useDraft(saved, async () => null), {
    initialProps: { saved: initial },
  });

test("草稿没被改过：已保存的值变了（刷新、别处改的）草稿跟着走，不会误判成有修改", () => {
  const h = make({ v: "a" });
  expect(h.result.current.dirty).toBe(false);
  h.rerender({ saved: { v: "b" } });
  expect(h.result.current.draft).toEqual({ v: "b" });
  expect(h.result.current.dirty).toBe(false);
});

test("草稿被改过：已保存的值变了也保留用户的修改，并仍然算有修改", () => {
  const h = make({ v: "a" });
  act(() => h.result.current.setDraft({ v: "mine" }));
  h.rerender({ saved: { v: "b" } });
  expect(h.result.current.draft).toEqual({ v: "mine" });
  expect(h.result.current.dirty).toBe(true);
});

test("保存成功后服务端回来的值与草稿一致：不再有修改；放弃回到已保存的值", async () => {
  const onSave = vi.fn(async () => null);
  const h = renderHook(({ saved }) => useDraft(saved, onSave), {
    initialProps: { saved: { v: "a" } },
  });
  act(() => h.result.current.setDraft({ v: "x" }));
  await act(async () => {
    expect(await h.result.current.save()).toBe(true);
  });
  expect(onSave).toHaveBeenCalledWith({ v: "x" });
  h.rerender({ saved: { v: "x" } });
  expect(h.result.current.dirty).toBe(false);
  act(() => h.result.current.setDraft({ v: "y" }));
  act(() => h.result.current.discard());
  expect(h.result.current.draft).toEqual({ v: "x" });
});
