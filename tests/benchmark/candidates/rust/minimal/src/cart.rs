pub struct Cart {
    pub items: Vec<u32>,
}

impl Cart {
    pub fn new(items: Vec<u32>) -> Self {
        Cart { items }
    }

    /// The sum of the items.
    pub fn total(&self) -> u32 {
        self.items.iter().sum()
    }
}

pub trait Priced {
    fn price(&self) -> u32;
}

impl Priced for Cart {
    fn price(&self) -> u32 {
        self.total()
    }
}

pub fn make_cart() -> Cart {
    Cart::new(vec![1, 2, 3])
}

pub fn priced(p: &dyn Priced) -> u32 {
    p.price()
}
