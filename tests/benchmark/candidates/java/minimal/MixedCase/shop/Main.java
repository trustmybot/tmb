package shop;

public class Main {
    static Cart makeCart() {
        return new Cart().add(new Item("🍎 Größe", 3)).add(new Item("ß", 4));
    }

    public static void main(String[] args) {
        var c = makeCart();
        System.out.println(c.total());
    }
}
