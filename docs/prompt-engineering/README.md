# Prompt engineering

tmb splits every rule an agent follows into two layers:

- **Deterministic:** code decides. The engine behind the tool server and the command line, checkpoints (git's own hooks first, then the few host hooks an adapter writes), each role file's tool list, schema constraints and skill `paths:` (Planned, trustmybot/tmb#436) apply the rule whatever the prompt says.
- **Judgment:** a model reads prose (the role prompts in `roles/`, which each host's adapter writes in that host's format, and skills, Planned, trustmybot/tmb#436) and decides.

A rule goes deterministic whenever a check can decide it: a sequence, a default, a constraint or a measurement against a stable spec. Only what needs judgment stays in a prompt, such as classifying, composing, or weighing new context. Where a harder layer fits, it also enforces a rule that a prompt states, so when the prompt line is dropped, the failure is loud instead of silent.

## Index

- [DETERMINISTIC_LAYER.md](DETERMINISTIC_LAYER.md) — The rules for the deterministic layer: the six layers and what each guarantees, the boundary test for moving a rule out of a prompt, the coverage matrix, how to add a deterministic check, and the prompt cache zones.
- [JUDGMENT_LAYER.md](JUDGMENT_LAYER.md) — The rules for the judgment layer: yes/no criteria in the order a prompt is written, the grading rubric, real examples, and the eval set a prompt needs.
- [PROMPT_ENGINEERING.md](PROMPT_ENGINEERING.md) — The research reference: each rule with how strong its evidence is and where that evidence comes from. Writing or checking a prompt does not require it.
