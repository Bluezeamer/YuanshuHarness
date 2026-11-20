// 配对码：一次性、5 分钟过期、大小写不敏感、超过 20 个丢最早的。
import { expect, test } from "vitest";
import { PAIRING_TTL_MS, PairingCodes } from "./pairing.js";

const ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

test("码是 8 位、字符集里没有易混字符", () => {
  const codes = new PairingCodes();
  for (let i = 0; i < 50; i++) {
    const { code } = codes.create();
    expect(code).toMatch(ALPHABET);
    expect(code).not.toMatch(/[01OI]/);
  }
});

test("有效期 5 分钟，expiresAt 是 ISO 字符串", () => {
  const clock = { t: 1_000_000_000_000 };
  const codes = new PairingCodes(() => clock.t);
  const { code, expiresAt } = codes.create();
  expect(expiresAt).toBe(new Date(clock.t + PAIRING_TTL_MS).toISOString());
  expect(codes.redeem(code)).toBe(true);
});

test("一次性：第二次兑换为 false", () => {
  const codes = new PairingCodes();
  const { code } = codes.create();
  expect(codes.redeem(code)).toBe(true);
  expect(codes.redeem(code)).toBe(false);
});

test("过期后不能兑换；过期的码在访问时被清掉，不影响新码", () => {
  const clock = { t: 1_000_000_000_000 };
  const codes = new PairingCodes(() => clock.t);
  const old = codes.create();
  const fresh = codes.create();
  clock.t += PAIRING_TTL_MS - 1;
  expect(codes.redeem(fresh.code)).toBe(true);
  clock.t += 1;
  expect(codes.redeem(old.code)).toBe(false);
});

test("大小写不敏感，前后空白也认", () => {
  const codes = new PairingCodes();
  const { code } = codes.create();
  expect(codes.redeem(` ${code.toLowerCase()} `)).toBe(true);
});

test("最多留 20 个有效码，超过丢最早的", () => {
  const clock = { t: 1_000_000_000_000 };
  const codes = new PairingCodes(() => clock.t);
  const created = Array.from({ length: 21 }, () => codes.create().code);
  expect(codes.redeem(created[0] as string)).toBe(false);
  for (const code of created.slice(1)) expect(codes.redeem(code)).toBe(true);
});
