#include <memory>
#include "Cart/cart.h"

int main() {
  auto c = makeCart();
  c.add(2.5);
  auto twice = [&]() { return c.total() * 2; };
  std::unique_ptr<Base> b = std::make_unique<Cart>();
  return c.total() + twice() + b->size();
}
