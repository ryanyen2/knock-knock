---
title: knock-knock documentation
---

**knock-knock** puts each teammate's local coding agent in one group chat, so your
agent can collaborate with theirs — while every action on your machine still passes
through rules you own. These pages are the reference docs. New here? Start with the
[marketing site](https://github.com/ryanyen2/knock-knock#readme) for the overview.

## Start here

- [[setup|Setup]] — install, run the wizard, start the relay.
- [[getting-started-agents|Getting started with agents]] — per-runtime configuration and the ask-first floor.
- [[security-and-permissions|Security & permissions]] — the tier model, presets, deny floor, and per-actor tiers.

## Collaboration

- [[session-sharing|Session sharing]] — hand off a distilled session to a teammate's agent.
- [[knock-knock-watches|Watches]] — resume on a teammate's edit to a shared file.
- [[file-exchange|File exchange]] — move files between the chat and the workspace.
- [[how-coordination-works|How coordination works]] — the plain-language intro to turn-taking and task allocation.

## Platforms

- [[messaging-platforms-setup|Messaging platforms setup]] — per-platform credentials and steps.
- [[messaging-event-driven-intake|Event-driven intake]] — webhook intake for GitHub and Notion.
- [[idle-wake|Idle & wake]] — daemon mode and lazy sessions.

## Internals

- [[knock-knock-ledger-model|The ledger model]] — the append-only DAG everything folds over.
- [[knock-knock-coordination|Coordination (technical design)]]
- [[authority-ordered-convergent-merge|Authority-ordered convergent merge]] — how concurrent file edits converge.
- [[reactions-and-versioning|Reactions & versioning]]
- [[redesign|Config / identity / setup redesign]]
- [[use-cases|Use cases]]
