#include <stdlib.h>
#include "cart.h"

static int helper(int n) { return n * 2; }

static const struct cart_ops OPS = { cart_total };

struct cart *make_cart(void) {
  struct cart *c = malloc(sizeof *c);
  c->ops = &OPS;
  c->items = helper(1);
  return c;
}

int cart_total(const struct cart *c) {
  return c->items;
}
