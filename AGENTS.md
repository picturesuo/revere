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
- Keep durable reusable knowledge in `docs/knowledge.md`; keep current-task state in the shared context file.

## Skill Philosophy
- Prefer simplified skills: short descriptions, clear trigger nouns, and only the workflow steps needed to act.
- Load a skill only when the task clearly calls for it; do not spend prompt budget on broad background.
- When updating or creating skills, preserve the product/tool/action/object words that make the skill easy to trigger.
- Split a skill only when separate workflows have different triggers or owners; otherwise keep the guidance compact.
- Treat repo-local guidance as policy. Avoid duplicating built-in Codex skills unless this repo needs a narrower rule.

## Working Rules
- Keep scope tight.
- Prefer small, reversible changes.
- State assumptions explicitly when needed.
- Publish only verified completed work.
- Use a local-only commit only when it is intentional.
- Do not auto-publish partial, failing, or unverified work.
- After each individual file is changed and verified, commit and push that file before editing the next file.
- Prefer many small pushed commits over batching multiple changed files into one commit, unless the user explicitly asks for a batch.
