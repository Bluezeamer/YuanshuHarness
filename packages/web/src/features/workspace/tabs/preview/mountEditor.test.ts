// 语言映射：预览与编辑都用它，漏了映射就等于没高亮（svg 之前就是这样）。
// 现在不维护白名单，直接查 CodeMirror 官方语言注册表——这里锁住「常见语言必须认得出来」。
import { expect, test } from "vitest";
import { langNameFor, mountEditor } from "./mountEditor";

test("常见编程语言都能认出来", async () => {
  expect(await langNameFor("/w/a.ts")).toBe("TypeScript");
  expect(await langNameFor("a.tsx")).toBe("TSX");
  expect(await langNameFor("a.js")).toBe("JavaScript");
  expect(await langNameFor("a.py")).toBe("Python");
  expect(await langNameFor("a.rs")).toBe("Rust");
  expect(await langNameFor("a.go")).toBe("Go");
  expect(await langNameFor("a.java")).toBe("Java");
  expect(await langNameFor("a.kt")).toBe("Kotlin");
  expect(await langNameFor("a.swift")).toBe("Swift");
  expect(await langNameFor("a.c")).toBe("C");
  expect(await langNameFor("a.h")).toBe("C");
  expect(await langNameFor("a.cpp")).toBe("C++");
  expect(await langNameFor("a.cs")).toBe("C#");
  expect(await langNameFor("a.php")).toBe("PHP");
  expect(await langNameFor("a.rb")).toBe("Ruby");
  expect(await langNameFor("a.lua")).toBe("Lua");
  expect(await langNameFor("a.scala")).toBe("Scala");
  expect(await langNameFor("a.hs")).toBe("Haskell");
  expect(await langNameFor("a.dart")).toBe("Dart");
  expect(await langNameFor("a.ps1")).toBe("PowerShell");
});

test("配置与数据格式也都认得（toml 这类以前完全没有高亮）", async () => {
  expect(await langNameFor("main.toml")).toBe("TOML");
  expect(await langNameFor("a.yaml")).toBe("YAML");
  expect(await langNameFor("a.yml")).toBe("YAML");
  expect(await langNameFor("a.json")).toBe("JSON");
  expect(await langNameFor("a.ini")).toBe("Properties files");
  expect(await langNameFor("nginx.conf")).toBe("Nginx");
  expect(await langNameFor("a.proto")).toBe("ProtoBuf");
});

test("脚本、查询与文档类语言", async () => {
  expect(await langNameFor("run.sh")).toBe("Shell");
  expect(await langNameFor("q.sql")).toBe("SQL");
  expect(await langNameFor("a.md")).toBe("Markdown");
  expect(await langNameFor("a.html")).toBe("HTML");
  expect(await langNameFor("a.css")).toBe("CSS");
  expect(await langNameFor("a.scss")).toBe("SCSS");
  expect(await langNameFor("a.less")).toBe("LESS");
  expect(await langNameFor("a.vue")).toBe("Vue");
  expect(await langNameFor("a.tex")).toBe("LaTeX");
  expect(await langNameFor("a.diff")).toBe("diff");
});

test("标签语言：svg / xml 也要高亮", async () => {
  expect(await langNameFor("logo.svg")).toBe("XML");
  expect(await langNameFor("data.xml")).toBe("XML");
});

test("按文件名认：Cargo.toml / Dockerfile / CMakeLists.txt", async () => {
  expect(await langNameFor("/p/Cargo.toml")).toBe("TOML");
  expect(await langNameFor("Dockerfile")).toBe("Dockerfile");
  expect(await langNameFor("CMakeLists.txt")).toBe("CMake");
});

test("认不出的按纯文本（null），不要瞎配一个语言", async () => {
  expect(await langNameFor("notes.txt")).toBeNull();
  expect(await langNameFor("data.csv")).toBeNull();
  expect(await langNameFor("Makefile")).toBeNull();
});

test("selection()：没选内容是 null；选中给文字与行号区间，整行选中不把下一行算进去", async () => {
  const { EditorView } = await import("@codemirror/view");
  const parent = document.createElement("div");
  document.body.append(parent);
  const handle = await mountEditor({
    parent,
    doc: "第一行\n第二行\n第三行\n",
    path: "a.md",
    readOnly: false,
    onChange: () => {},
    onSave: () => {},
  });
  const view = EditorView.findFromDOM(parent) as InstanceType<
    typeof EditorView
  >;
  const select = (anchor: number, head: number) =>
    view.dispatch({ selection: { anchor, head } });

  select(2, 2);
  expect(handle.selection()).toBeNull();
  select(1, 6); // 第一行末尾到第二行中间
  expect(handle.selection()).toEqual({ text: "一行\n第二", from: 1, to: 2 });
  select(4, 8); // 第二行整行（含换行），止于第三行行首
  expect(handle.selection()).toEqual({ text: "第二行\n", from: 2, to: 2 });
  handle.destroy();
  parent.remove();
});
