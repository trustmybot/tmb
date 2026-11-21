"""Reads and writes the to-do file."""
import json
from pathlib import Path


def load(path):
    file = Path(path)
    if not file.exists():
        return []
    return json.loads(file.read_text())


def save(path, items):
    Path(path).write_text(json.dumps(items, indent=2))
