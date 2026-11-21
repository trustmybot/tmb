"""Adds and lists to-do items in a JSON file."""
import sys

from todo_tools import load, save


def add_item(path, title):
    items = load(path)
    items.append({"title": title.strip(), "done": False})
    save(path, items)
    return items


def list_items(path):
    items = load(path)
    return sorted(items, key=lambda item: item["done"])


def main(argv):
    if len(argv) >= 3 and argv[1] == "add":
        add_item(argv[0], argv[2])
    for item in list_items(argv[0]):
        print(("[x] " if item["done"] else "[ ] ") + item["title"])


if __name__ == "__main__":
    main(sys.argv[1:])
