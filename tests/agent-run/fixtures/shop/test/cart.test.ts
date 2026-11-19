import { expect, test } from "bun:test";
import { subtotal } from "../src/cart";

test("subtotal sums each line", () => {
  expect(subtotal([{ productId: "mug", quantity: 2 }, { productId: "tee", quantity: 1 }])).toBe(44);
});
