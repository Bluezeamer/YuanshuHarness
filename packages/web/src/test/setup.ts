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

// jsdom 没有实现 object URL：附件缩略图与上传预览用固定 URL 即可（真浏览器走原生实现）。
if (typeof URL.createObjectURL !== "function") {
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
}
