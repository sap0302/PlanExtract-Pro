# Roadmap

Work planned for PlanExtract Pro, roughly in priority order. Items come from
sessions with the estimators using it day to day.

## Measure page

- [ ] **Reusable item library.** Let a user build a list of standard items
      (1" poly, 8" DIP, 18" RCP, fire hydrant, ...) once and reuse it on every
      plan instead of re-typing names per project. Needs a new model, a picker
      in the sidebar, and import from a finished takeoff.
- [ ] **Tiled page rendering.** Large sheets are slow at high zoom because the
      whole page re-renders. Render only the visible region.
- [ ] **Edit existing runs.** Drag vertices of a completed linear or area
      measurement instead of deleting and redrawing.
- [ ] **Snap to existing points** and orthogonal constraint (hold Shift).
- [ ] **Running totals panel** that shows all items across pages, not only the
      per-page tree.
- [ ] **Per-project export of markups** as a marked-up PDF, matching the
      quantity report.

## Extraction

- [ ] Add newer provider models and make the model selectable per extraction.
- [ ] Capture station numbers and depths as structured fields, not only in
      evidence text.
- [ ] Separate water / storm / sewer sheets automatically before extraction so
      each chunk gets a system-specific prompt.
- [ ] Confidence calibration: compare AI quantities with manual measurements
      taken on the same extraction and surface items that drift most.

## Platform

- [ ] Move from SQLite to Postgres and store PDFs outside the database.
- [ ] Background job queue for long extractions (currently runs inside the
      request).
- [ ] Automated tests for aggregation/de-duplication, scale math and the
      email verification flow. There are none today beyond type checking.
- [ ] CI: typecheck, lint and build on every push.
- [ ] Audit log for admin actions.

## Docs

- [ ] Screenshots and a short walkthrough video in the README.
- [ ] A guide for writing reference examples.
