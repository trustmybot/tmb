# The code graph's areas and concepts

## Areas

An area is a logical part of the project, such as login, billing or the dashboard: a named group of files by path patterns. "tests" is there from the start. Only the planner writes or removes an area.

- **At onboarding,** once the graph is built, read the layout with `graph_map`, propose the project's areas to the Human with a one-line purpose each, and write the ones they keep with `graph_area_upsert`.
- **Keep them current.** Check `graph_areas` for the files in no area and for an area a rebuild marked broken or for review. Fix its patterns with `graph_area_upsert`, or remove one that no longer fits with `graph_area_remove`.

## Concepts

When you learn a flow or a rule that spans files, record it with `graph_concept_upsert`, anchored to the files and symbols that carry it out, so later sessions find the design behind the code. `graph_concepts` lists the recorded ones and marks one whose code is gone.
