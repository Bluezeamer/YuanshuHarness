import { expect, test } from "vitest";
import { testData } from "../../test/support/stub.js";
import { PluginSwitchStore } from "./plugins.js";

test("空库全关；打开、关闭按来源记，互不影响", () => {
  const data = testData();
  try {
    const store = new PluginSwitchStore(data.db);
    expect([...store.enabled()]).toEqual([]);

    store.set("npm:a", true);
    store.set("npm:b", true);
    expect([...store.enabled()].sort()).toEqual(["npm:a", "npm:b"]);

    store.set("npm:a", false);
    store.set("npm:a", false);
    expect([...store.enabled()]).toEqual(["npm:b"]);
  } finally {
    data.close();
  }
});
