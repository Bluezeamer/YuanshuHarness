import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Attachment } from "../model/draft";
import {
  attachmentPaths,
  pendingReason,
  refToAttachment,
  useLocalAttachments,
} from "./attachments";

const file = (over: Partial<Attachment> = {}): Omit<Attachment, "id"> => ({
  name: "a.txt",
  mimeType: "text/plain",
  size: 1,
  path: "a.txt",
  status: "ready",
  progress: 100,
  ...over,
});

test("本地存放：增删改按 id，id 全局唯一且带 l 前缀（不与会话草稿的 a<n> 相撞）", () => {
  const a = renderHook(() => useLocalAttachments());
  const b = renderHook(() => useLocalAttachments());
  let first = { id: "" };
  let second = { id: "" };
  act(() => {
    first = a.result.current.add(file());
    second = b.result.current.add(file());
  });
  expect(first.id).toMatch(/^l\d+$/);
  expect(first.id).not.toBe(second.id);

  act(() => a.result.current.update(first.id, { status: "error" }));
  expect(a.result.current.list[0]?.status).toBe("error");
  act(() => a.result.current.remove(first.id));
  expect(a.result.current.list).toEqual([]);
});

test("本地存放：初始内容与 reset 都按引用生成新 id", () => {
  const ref = {
    name: "s.pdf",
    mime: "application/pdf",
    sizeText: "2 KB",
    path: "s.pdf",
  };
  const { result } = renderHook(() =>
    useLocalAttachments([refToAttachment(ref)]),
  );
  expect(result.current.list).toHaveLength(1);
  act(() => result.current.reset([refToAttachment(ref), refToAttachment(ref)]));
  expect(new Set(result.current.list.map((x) => x.id)).size).toBe(2);
});

test("引用转附件：已就绪，体积用服务端给的文案，不再上传", () => {
  expect(
    refToAttachment({
      name: "s.pdf",
      mime: "application/pdf",
      sizeText: "2 KB",
      path: "d/s.pdf",
    }),
  ).toEqual({
    name: "s.pdf",
    mimeType: "application/pdf",
    size: 0,
    sizeText: "2 KB",
    path: "d/s.pdf",
    status: "ready",
    progress: 100,
  });
});

test("发出去的只有路径；没就绪的给出不能发的原因，全部就绪返回 null", () => {
  const ready = { id: "1", ...file() };
  const uploading = { id: "2", ...file({ status: "uploading", progress: 3 }) };
  const failed = { id: "3", ...file({ status: "error" }) };
  expect(attachmentPaths([ready])).toEqual([{ path: "a.txt" }]);
  expect(pendingReason([ready])).toBeNull();
  expect(pendingReason([ready, uploading])).toBe("附件还在上传，请稍候再发送");
  expect(pendingReason([ready, failed])).toBe("有附件上传失败，请重试或移除");
});
