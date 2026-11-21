import os
import tempfile
import unittest

from todo_cli import add_item, list_items


class TodoTest(unittest.TestCase):
    def test_add_then_list(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "todo.json")
            add_item(path, " milk ")
            self.assertEqual(list_items(path), [{"title": "milk", "done": False}])


if __name__ == "__main__":
    unittest.main()
