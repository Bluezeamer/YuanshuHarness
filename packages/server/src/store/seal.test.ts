// 加密小件：往返、随机 iv、篡改与换密钥都解不开、格式。
import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { seal, unseal } from "./seal.js";

const key = () => randomBytes(32);

test("往返：中文与 emoji 都原样回来", () => {
  const k = key();
  for (const plain of ["", "hunter2", "中文密码 🔐 带 emoji", "a".repeat(4096)])
    expect(unseal(k, seal(k, plain))).toBe(plain);
});

test("同一明文两次加密结果不同（iv 随机）", () => {
  const k = key();
  expect(seal(k, "same").equals(seal(k, "same"))).toBe(false);
});

test("长度是 12 + 16 + 明文字节数，前 12 字节是 iv", () => {
  const k = key();
  const plain = "中文";
  const blob = seal(k, plain);
  expect(blob.length).toBe(12 + 16 + Buffer.byteLength(plain));
  // 两次的 iv 不同，说明前 12 字节确实是随机的 iv。
  expect(blob.subarray(0, 12).equals(seal(k, plain).subarray(0, 12))).toBe(
    false,
  );
});

test("篡改密文的任一字节都解不开", () => {
  const k = key();
  const blob = seal(k, "tamper me");
  for (let i = 0; i < blob.length; i++) {
    const bad = Buffer.from(blob);
    bad[i] = (bad[i] ?? 0) ^ 0xff;
    expect(() => unseal(k, bad)).toThrow();
  }
});

test("换一把密钥解不开", () => {
  const blob = seal(key(), "secret");
  expect(() => unseal(key(), blob)).toThrow();
});
