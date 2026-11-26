#include <stdio.h>
#include "Cart/cart.h"

/* A second helper with internal linkage: calls in this file reach this one only. */
static int helper(int n) { return n + 1; }

int main(void) {
  __auto_type c = make_cart();
  int a = cart_total(c);
  int b = c->ops->total(c);
  printf("%d\n", helper(a + b));
  return 0;
}
