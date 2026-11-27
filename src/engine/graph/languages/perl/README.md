# Perl

The code graph's rules for the files GitHub Linguist's list and rules call Perl (trustmybot/tmb#154): its endings, such as `.pl` and `.pm`, once Linguist's heuristics tell them from Prolog and Raku, and a file whose first line names perl. Perl has no grammar here; its rules are patterns ([index.ts](index.ts)).

## What it reads

- Each `sub` is one function node, with the `#` comment block above it as its doc. A forward declaration is not one.
- Each `use constant` is a constant node, one per key of a constant block.

Its fixtures and a coverage test of its own come with trustmybot/tmb#141.
