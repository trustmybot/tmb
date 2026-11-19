import { expect, test } from "bun:test";
import { percentOff } from "../src/pricing/discount";
import { withTax } from "../src/pricing/tax";

test("percentOff takes the percent off", () => {
  expect(percentOff(200, 25)).toBe(150);
});

test("withTax adds the tax", () => {
  expect(withTax(100)).toBe(108);
});
