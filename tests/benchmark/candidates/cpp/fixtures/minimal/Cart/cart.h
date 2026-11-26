#pragma once
#include <vector>

class Base {
 public:
  virtual ~Base() = default;
  virtual int size() const = 0;
};

class Cart : public Base {
 public:
  Cart();
  int total() const;
  int size() const override { return static_cast<int>(items_.size()); }
  void add(int price) { items_.push_back(price); }
  void add(double price) { items_.push_back(static_cast<int>(price)); }

 private:
  std::vector<int> items_;
};

Cart makeCart();
