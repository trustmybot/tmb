export type Product = { id: string; name: string; price: number };

export const PRODUCTS: Product[] = [
  { id: "mug", name: "Mug", price: 12 },
  { id: "tee", name: "T-shirt", price: 20 },
];

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
