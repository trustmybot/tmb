#include "cart.h"

Cart::Cart() { add(1); }

int Cart::total() const {
  int sum = 0;
  for (int p : items_) sum += p;
  return sum;
}

Cart makeCart() { return Cart(); }
