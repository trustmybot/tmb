// The page's example in Rust: `c = makeCart(); c.total()`. The type of `c` is not written at
// the call, so only a tool that knows types can link `c.total()` to `Cart::total`.
mod cart;

use cart::{make_cart, priced, Priced};

fn main() {
    let c = make_cart();
    let sum = c.total();
    let doubled: Vec<u32> = c.items.iter().map(|x| x * 2).collect();
    // A trait's method on a value of known type: the compiler names the trait's method, and the
    // implementation for `Cart` is the one that runs.
    let p = c.price();
    let q = priced(&c);
    println!("{} {} {} {}", sum, doubled.len(), p, q);
}
