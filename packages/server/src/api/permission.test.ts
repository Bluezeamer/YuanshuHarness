import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NO_REMEMBER_FIRST } from "../permission/bash.js";
import { SENSITIVE_NAMES } from "../permission/paths.js";
import { permissionApi } from "./permission.js";

let app: FastifyInstance;
beforeEach(async () => {
  app = Fastify();
  app.register(permissionApi);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

test("硬边界清单来自判定用的常量，而不是另抄一份", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/permission/boundaries",
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const sensitive = body.boundaries.find(
    (b: { id: string }) => b.id === "sensitive",
  );
  expect(sensitive.items).toEqual([...SENSITIVE_NAMES]);
  expect(new Set(body.noRemember)).toEqual(NO_REMEMBER_FIRST);
  // 每条都带标题、说明与完全允许档下的行为，前端据此直接渲染
  for (const b of body.boundaries) {
    expect(typeof b.title).toBe("string");
    expect(typeof b.detail).toBe("string");
    expect(typeof b.inFull).toBe("boolean");
  }
});

test("只读：不接受写入", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/permission/boundaries",
    payload: {},
  });
  expect(res.statusCode).toBe(404);
});
