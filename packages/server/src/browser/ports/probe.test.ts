import type { Duplex } from "node:stream";
import { expect, test } from "vitest";
import { isListening } from "./probe.js";

function fakeSocket() {
  const s = {
    destroyed: false,
    destroy() {
      s.destroyed = true;
    },
  };
  return s as unknown as Duplex & { destroyed: boolean };
}

test("连上就返回 true，并把连接关掉", async () => {
  const socket = fakeSocket();
  expect(await isListening({ openTcp: async () => socket }, 3000)).toBe(true);
  expect(socket.destroyed).toBe(true);
});

test("连不上（抛错）是 false", async () => {
  const env = {
    openTcp: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  expect(await isListening(env, 3000)).toBe(false);
});

test("一直不返回：超时 false，迟到的连接也要关掉", async () => {
  let connect: (s: Duplex) => void = () => {};
  const env = {
    openTcp: () =>
      new Promise<Duplex>((ok) => {
        connect = ok;
      }),
  };
  expect(await isListening(env, 3000, 20)).toBe(false);
  const late = fakeSocket();
  connect(late);
  await new Promise((r) => setTimeout(r, 0));
  expect(late.destroyed).toBe(true);
});

test("环境没有 openTcp 或 env 为 null 都是 false", async () => {
  expect(await isListening({}, 3000)).toBe(false);
  expect(await isListening(null, 3000)).toBe(false);
});

test("openTcp 同步抛错也是 false", async () => {
  const env = {
    openTcp: (() => {
      throw new Error("boom");
    }) as unknown as (port: number) => Promise<Duplex>,
  };
  expect(await isListening(env, 3000)).toBe(false);
});
