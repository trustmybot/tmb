import { cartTotal, type Line } from "../cart";

export function receipt(lines: Line[], member: boolean): string {
  return `Total: $${cartTotal(lines, member).toFixed(2)}`;
}
