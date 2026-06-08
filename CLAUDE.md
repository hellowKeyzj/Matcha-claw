# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## 5. Subagent Parallel Development

**Prefer parallel subagent implementation with low-conflict task boundaries.**

When using subagents for development:
- For every newly started subagent, first consider whether an existing related subagent session can be reused.
- Use subagents for implementation work when the task can be split cleanly.
- Do not use worktrees for subagent development; work directly on the current branch.
- Run parallelizable subagent tasks in parallel, not serially; do not wait for one independent group to finish before starting another when their file/module boundaries do not conflict.
- Prefer one broad upfront partition that covers the whole requested feature scope, assigning as many subagents as needed; agent count is not a concern when boundaries are low-conflict.
- Split work by low-conflict boundaries: files, feature slices, providers/plugins, routes, clients, stores, UI components, or test areas.
- Avoid assigning multiple subagents to edit the same file, shared contract, registry, core type definition, or common helper at the same time.
- If shared contracts, public types, registries, or common helpers must change, make that shared change in one place first, then parallelize downstream call-site updates.
- The main agent is responsible for final integration: inspect the combined diff, resolve conflicts, remove accidental overlap, and run verification.

---

## 6. Communication Language

**Default to Chinese.**

- Reply to the user in Chinese unless they explicitly request another language.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
