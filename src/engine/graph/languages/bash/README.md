# bash and sh

The code graph's rules for `.sh` and `.bash` files, and for files with no extension whose shebang names bash or sh. They are read through tree-sitter's bash grammar ([index.ts](index.ts)).

## What it reads

- Each function definition is one node, with the comment above it as its doc.
- Inside a function or at the top of the file, a command is linked as one of these:
  - a call of a function, unless it is a builtin or a common tool;
  - a run of another script;
  - a `source` of one.
- SQL held in a command's strings links to the tables it reads or writes, through the [SQL module](../sql/index.ts).

Every function as a node, with its fixtures and a coverage test of its own, comes with trustmybot/tmb#141.
