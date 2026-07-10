# Contributing

This repository is still a prototype / architecture demo. Keep changes small, explicit, and easy to review.

## Contribution Rules

1. State the scope of the change clearly.

For every PR or commit, explain:

- what part of the repo changed
- why that part needed to change
- what the actual behavior change is
- what is intentionally not changed

Good example:

`apps/web: update demo preview header copy and selected block summary. No protocol or runtime behavior changed.`

Bad example:

`improve demo page`

2. Separate structural changes from visual or copy changes.

Do not mix these in one change unless they are tightly coupled:

- demo page UI updates
- event / protocol schema changes
- session reduction logic changes
- runtime behavior changes
- docs-only updates

If a change touches multiple layers, describe each layer separately.

3. Describe the actual change, not just the intention.

Avoid vague summaries like:

- clean up
- improve UX
- fix demo
- refactor stuff

Prefer concrete summaries like:

- add a new `DiffPanel` empty state message
- rename `preview.open` label text in the web demo
- extend `AgentEvent` with a new interaction resolution field
- update browser runtime preview fallback for non-HTML files

4. Keep demo changes honest.

Do not describe stubbed behavior as if it were production-ready.

Examples:

- say `browser runtime stub`, not full sandbox
- say `demo agent flow`, not production agent service
- say `placeholder remote runtime`, not implemented remote execution

5. Keep current-state docs and future-state docs distinct.

When editing docs:

- `README.md` and repo overview docs should describe the current implementation
- design notes under `docs/design/` may describe future direction, but should say so clearly

Do not present roadmap ideas as already implemented behavior.

## Repo Areas

Use these boundaries when describing your changes:

- `apps/web`
  Demo UI, workbench view model, interactive block editing state, demo page behavior.

- `apps/agent`
  Demo agent flow, seeded event generation, approval flow, patch replay behavior.

- `packages/protocol`
  Shared Zod schemas and TypeScript types for events, actions, plans, sessions, and interactions.

- `packages/core`
  Session reduction, session store, executor plumbing, runtime interfaces.

- `packages/model-gateway`
  Stubbed model routing and task profiles.

- `packages/runtime-browser`
  Browser runtime stub, file replay, preview replay, runtime event watching.

- `packages/runtime-remote`
  Placeholder remote runtime adapter.

- `packages/ui`
  Shared workbench panel definitions and labels.

- `docs/design`
  Architecture notes, design references, and future-facing planning docs. Files prefixed with `future-` describe upcoming phases.

## PR / Commit Checklist

Before submitting, make sure your change description answers:

- Which files or package areas changed?
- What user-visible or developer-visible behavior changed?
- Is this a UI change, logic change, protocol change, runtime change, or docs change?
- Does the change affect current implementation, future design notes, or both?
- What did you explicitly avoid changing?

## Preferred Change Summary Format

Use a short format like this in PRs or commit messages:

`area: actual change`

Examples:

- `apps/web: adjust demo page hero layout and block editor labels`
- `packages/core: preserve pending interaction on unrelated action updates`
- `packages/protocol: add follow-up strategy to interaction resolution event`
- `docs: align zh architecture notes with current runtime terminology`

For larger changes, add a short body with:

- changed area
- actual behavior change
- non-goals
- verification performed
