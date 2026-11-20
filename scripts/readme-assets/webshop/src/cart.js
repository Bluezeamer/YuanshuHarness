// 购物车价格计算：小计、优惠券、运费、总价（保留两位小数）。

const FREE_SHIPPING_OVER = 99;
const FLAT_SHIPPING = 8;

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

/** 优惠券：percent 是折扣百分数，10 表示打 9 折。 */
export function applyCoupon(total, coupon) {
  if (!coupon) return total;
  return total - total * coupon.percent;
}

/** 满 99 包邮，否则统一收 8 元。 */
export function shippingFee(total) {
  return total >= FREE_SHIPPING_OVER ? 0 : FLAT_SHIPPING;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function cartTotal(items, coupon) {
  const discounted = applyCoupon(subtotal(items), coupon);
  return round2(discounted + shippingFee(discounted));
}
