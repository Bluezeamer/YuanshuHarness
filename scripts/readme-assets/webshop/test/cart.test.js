import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal, round2, shippingFee, subtotal } from "../src/cart.js";

const items = [
  { sku: "tee-black", price: 19.9, qty: 2 },
  { sku: "mug-white", price: 5, qty: 1 },
];

test("subtotal sums price x qty", () => {
  assert.equal(subtotal(items), 44.8);
});

test("shipping is free from 99 and flat 8 below", () => {
  assert.equal(shippingFee(120), 0);
  assert.equal(shippingFee(44.8), 8);
});

test("round2 keeps two decimals", () => {
  assert.equal(round2(40.321), 40.32);
});

test("cartTotal without coupon adds shipping", () => {
  assert.equal(cartTotal(items), 52.8);
});

test("cartTotal applies a percentage coupon", () => {
  assert.equal(cartTotal(items, { code: "SPRING10", percent: 10 }), 48.32);
});

test("a 100% coupon leaves only shipping", () => {
  assert.equal(cartTotal(items, { code: "FREE", percent: 100 }), 8);
});
