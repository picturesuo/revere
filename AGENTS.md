# AGENTS.md

## Purpose
This file is the repo-local operating manual for Codex in "revere".

Read it at the start of each session.
Follow it unless the user explicitly overrides it.
Keep it current.

## Shared Context
- If a shared context file exists, use it as the durable task artifact for the current task.
- Update only the sections or artifact IDs owned by your role.
- Do not rewrite the whole shared context file.
- Keep durable reusable knowledge in ; keep current-task state in the shared context file.

## Working Rules
- Keep scope tight.
- Prefer small, reversible changes.
- State assumptions explicitly when needed.
- Publish verified completed work with .
- Use  only when a local-only commit is intentional.
- Do not auto-publish partial, failing, or unverified work.
