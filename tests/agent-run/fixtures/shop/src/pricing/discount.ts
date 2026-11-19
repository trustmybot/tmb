/** Percent off for customers in the loyalty program. */
export const LOYALTY_PERCENT = 10;

export function percentOff(total: number, percent: number): number {
  return Math.round(total * (100 - percent)) / 100;
}

export function loyaltyPrice(total: number): number {
  return percentOff(total, LOYALTY_PERCENT);
}
