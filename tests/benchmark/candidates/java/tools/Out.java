// The one output form every Java candidate writes, so run.ts reads every tool the same way
// (trustmybot/tmb#346). One JSON object per line:
//   {"t":"fn",...}   a callable the tool declares: its file, name, kind and lines (its own list);
//   {"t":"call",...} a call the tool sees: its file, the position where the called name is
//                    written (a UTF-16 offset, as Java and JavaScript strings count), the name, and
//                    the tool's answer: "repo" with the declaration's place, "outside", or "unknown".
//   {"t":"info",...} a count or a time the tool reports about itself.
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

final class Out implements AutoCloseable {
  private final PrintWriter w;

  Out(Path file) throws IOException {
    w = new PrintWriter(Files.newBufferedWriter(file, StandardCharsets.UTF_8));
  }

  static String q(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"' -> b.append("\\\"");
        case '\\' -> b.append("\\\\");
        case '\n' -> b.append("\\n");
        case '\r' -> b.append("\\r");
        case '\t' -> b.append("\\t");
        default -> {
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
        }
      }
    }
    return b.append('"').toString();
  }

  /** A declaration's place: file, name and lines (1-based, inclusive). */
  record Decl(String file, String name, int start, int end) {
    String json() {
      return "{\"file\":" + q(file) + ",\"name\":" + q(name) + ",\"start\":" + start + ",\"end\":" + end + "}";
    }
  }

  void fn(String file, String name, String kind, int start, int end) {
    w.println("{\"t\":\"fn\",\"file\":" + q(file) + ",\"name\":" + q(name) + ",\"kind\":" + q(kind) + ",\"start\":" + start + ",\"end\":" + end + "}");
  }

  /** state is "repo", "outside" or "unknown"; decls are given for "repo" only. */
  void call(String file, int pos, int line, String name, String state, List<Decl> decls, String why) {
    List<String> ds = new ArrayList<>();
    for (Decl d : decls) ds.add(d.json());
    w.println("{\"t\":\"call\",\"file\":" + q(file) + ",\"pos\":" + pos + ",\"line\":" + line + ",\"name\":" + q(name) + ",\"state\":" + q(state)
        + ",\"decls\":[" + String.join(",", ds) + "]" + (why == null ? "" : ",\"why\":" + q(why)) + "}");
  }

  void info(String key, String value) {
    w.println("{\"t\":\"info\",\"key\":" + q(key) + ",\"value\":" + q(value) + "}");
  }

  @Override
  public void close() {
    w.close();
  }

  /** The 1-based line of a UTF-16 offset, given each line's starting offset. */
  static int lineOf(int[] starts, int pos) {
    int lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      int mid = (lo + hi + 1) >>> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Where each line starts, as UTF-16 offsets. A line ends at \n, \r\n or a lone \r (JLS 3.4). */
  static int[] lineStarts(String text) {
    List<Integer> s = new ArrayList<>();
    s.add(0);
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c == '\r' && i + 1 < text.length() && text.charAt(i + 1) == '\n') continue;
      if (c == '\n' || c == '\r') s.add(i + 1);
    }
    return s.stream().mapToInt(Integer::intValue).toArray();
  }

  /** The files to read, one path per line, relative to the root. */
  static List<String> files(Path list) throws IOException {
    List<String> out = new ArrayList<>();
    for (String l : Files.readAllLines(list, StandardCharsets.UTF_8)) if (!l.isBlank()) out.add(l.trim());
    return out;
  }
}
