#ifndef CART_H
#define CART_H
struct cart;
struct cart_ops {
  int (*total)(const struct cart *c);
};
struct cart {
  const struct cart_ops *ops;
  int items;
};
struct cart *make_cart(void);
int cart_total(const struct cart *c);
#endif
