package shop

import "strings"

func Use() int {
	c := makeCart()
	n := c.Total()
	var t Totaler = c
	n += t.Total()
	b := Big{}
	n += b.Total()
	n += int(Amount(3)) + Sum(1, 2) + helper() + Sum[int](3)
	s := "héllo 😀"; s = strings.ToUpper(s); n += len(s)
	return n
}
