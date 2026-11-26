package pkg;

import java.util.function.Supplier;

public class Shapes {
    enum Color {
        RED, GREEN;

        Color next() {
            return values()[(ordinal() + 1) % 2];
        }
    }

    record Point(int x, int y) {
        Point {
            if (x < 0) throw new IllegalArgumentException();
        }

        int sum() {
            return x() + y();
        }
    }

    abstract static class Base {
        Base(String s) {
        }

        abstract int area();
    }

    class Inner {
        int v() {
            return 1;
        }
    }

    static class Square extends Base {
        Square() {
            this("sq");
        }

        Square(String s) {
            super(s);
        }

        int area() {
            return 4;
        }
    }

    static Base make() {
        return new Base("anon") {
            int area() {
                return 2;
            }
        };
    }

    int use() {
        Base b = make();
        Supplier<Integer> s = () -> new Point(1, 2).sum();
        Inner in = this.new Inner();
        return b.area() + s.get() + in.v() + Color.RED.next().ordinal();
    }
}
