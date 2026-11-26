package shop;

import java.util.ArrayList;
import java.util.List;

/** A cart of items. It writes no constructor, so the language gives it one (JLS 8.8.9). */
public class Cart {
    private final List<Item> items = new ArrayList<>();

    public Cart add(Item item) {
        items.add(item);
        return this;
    }

    public int total() {
        return items.stream().mapToInt(i -> i.price()).sum();
    }
}
