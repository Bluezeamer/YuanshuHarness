// 整套并发跑时 jsdom 创建与渲染会变慢，Testing Library 的 findBy/waitFor 默认 1000ms 容易偶发超时。
import { configure } from "@testing-library/dom";
import { beforeEach } from "vitest";
import { flushLocal } from "../app/localState";

configure({ asyncUtilTimeout: 5000 });

// 输入草稿等会落 localStorage；同一文件里上一条用例留下的内容不能漏进下一条（含还在防抖里、没落下的写）。
// 少数守卫测试跑在 node 环境里，没有 localStorage。
beforeEach(() => {
  flushLocal();
  if (typeof localStorage !== "undefined") localStorage.clear();
});

// object URL 一律打桩成固定 URL（真浏览器走原生实现）。不能用「没有才打桩」的判断：jsdom 自己没有，
// 但 Node 自带的 URL.createObjectURL 只认 Node 的 Blob，而这里全局的 Blob 是 jsdom 的，哪个版本的 Node 让
// Response.blob() 回哪一种也不同（22 回 Node 的，24 回 jsdom 的）——放着原生实现，用例就随 Node 版本变红。
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  writable: true,
  value: () => "blob:test",
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  writable: true,
  value: () => {},
});
