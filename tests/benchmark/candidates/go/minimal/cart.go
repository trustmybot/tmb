package shop

// Cart holds item prices.
type Cart struct{ items []int }

// Total sums the prices.
func (c *Cart) Total() int {
	sum := 0
	for _, p := range c.items {
		sum += p
	}
	return sum
}

func makeCart() *Cart { return &Cart{items: []int{1, 2}} }

// Totaler is anything with a total.
type Totaler interface {
	Total() int
}

// Big embeds a Cart, so Cart's methods are promoted to it.
type Big struct{ Cart }

type Amount int

func Sum[T ~int](xs ...T) T {
	var s T
	for _, x := range xs {
		s += x
	}
	return s
}

var helper = func() int { return 7 }
