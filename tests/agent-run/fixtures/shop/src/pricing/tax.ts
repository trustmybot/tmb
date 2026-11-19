export const TAX_RATE = 0.08;

export function withTax(total: number): number {
  return Math.round(total * (1 + TAX_RATE) * 100) / 100;
}
