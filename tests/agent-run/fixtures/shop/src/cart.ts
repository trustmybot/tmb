import { findProduct } from "./catalog/products";
import { loyaltyPrice } from "./pricing/discount";
import { withTax } from "./pricing/tax";

export type Line = { productId: string; quantity: number };

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + (findProduct(line.productId)?.price ?? 0) * line.quantity, 0);
}

export function cartTotal(lines: Line[], member: boolean): number {
  const sum = subtotal(lines);
  return withTax(member ? loyaltyPrice(sum) : sum);
}
