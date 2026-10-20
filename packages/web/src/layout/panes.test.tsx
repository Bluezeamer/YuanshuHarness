import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { defaultRegistry, PANE_META } from "./panes";
import { Registry } from "./registry";

afterEach(cleanup);

const registry = defaultRegistry();
const pendingIds = PANE_META.filter((m) => m.id !== "chat").map((m) => m.id);

test("注册表覆盖 mock 的 8 个视图类型，元数据完整", () => {
  expect(PANE_META.map((m) => m.id).sort()).toEqual(
    [
      "audit",
      "chat",
      "file_preview",
      "filediscovery",
      "pdf",
      "terminal",
      "topology",
      "web_preview",
    ].sort(),
  );
  expect(registry.list()).toHaveLength(PANE_META.length);
  for (const m of PANE_META) {
    const t = registry.get(m.id);
    expect(t?.group).toBe(m.group);
    expect(t?.tabbed).toBe(m.tabbed);
    expect(t?.follow).toBe(m.follow);
  }
});

test("follow 语义决定新条目的默认绑定：none 是钉住，其余跟随", () => {
  expect(registry.newEntry("pdf")?.binding?.mode).toBe("fixed");
  expect(registry.newEntry("terminal")?.binding?.mode).toBe("follow");
  expect(registry.newEntry("chat")?.binding?.mode).toBe("follow");
});

test("未接入的类型显示待接入占位，写明类型名", () => {
  for (const id of pendingIds) {
    const t = registry.get(id);
    const Comp = t?.component;
    if (!Comp) throw new Error(id);
    render(
      <Comp
        config={t.defaultConfig() as never}
        paneId="p"
        focused={false}
        binding={{ mode: "follow" }}
        onUpdateConfig={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      `「${PANE_META.find((m) => m.id === id)?.displayName}」待接入`,
    );
    cleanup();
  }
});

test("扩展点：自己注册一个组件即替换占位，其余类型不受影响", () => {
  const r = new Registry();
  const base = defaultRegistry();
  for (const t of base.list())
    r.register(
      t.id === "terminal"
        ? { ...t, component: () => <p>真终端</p> }
        : (t as never),
    );
  const Term = r.get("terminal")?.component;
  if (!Term) throw new Error("terminal");
  render(
    <Term
      config={{} as never}
      paneId="p"
      focused={false}
      binding={{ mode: "follow" }}
      onUpdateConfig={() => {}}
    />,
  );
  expect(screen.getByText("真终端")).toBeTruthy();
  expect(r.get("pdf")?.component).toBe(base.get("pdf")?.component);
});
