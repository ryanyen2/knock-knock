# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Coordination

### Peer bot
Another participant's coding agent in the same shared channel — a sibling on the same machine, or a collaborator's agent on another machine — discovered automatically rather than manually rostered.

A peer bot is heard and addressable much like a human, but it engages another bot only when explicitly addressed, so two agents don't loop on every broadcast in a busy channel.

### Directory
The shared, converging roster of known agents — their handles, the rooms they are in, and how to address them — that lets a bot discover and route to peers it was never manually configured with.

### Handoff
A directed pass of work from one bot to another, expressed as an addressed message (e.g. "@next-bot — refine?"). The receiving bot treats an addressed handoff as a turn to act on, distinct from a mention that merely appears inside another bot's status echo.

### Mesh
The cross-machine coordination transport that carries one machine's ledger activity to the others without a shared database, so every machine's view of who-did-what converges. Mesh traffic is coordination data, never a chat prompt.

## Scope

### Scope
The conversational unit a task runs in; a bot keys its engagement, history, and status surface to a scope. On platforms with sub-conversations the scope is a Task thread; where none exist it collapses to the whole channel (Channel scope).

### Task thread
A dedicated sub-conversation that holds one request's coordination and replies, created so that co-resident and cross-machine bots converge on the same one. Not every platform can open a task thread — a plain (non-forum) Telegram group has none — in which case the task falls back to Channel scope.

### Channel scope
The top-level room standing in as the task scope when no Task thread can be opened. On threadless surfaces the channel *is* the task surface, so a directed Handoff must be honored at channel scope, not only inside a thread.

## Status and admission

### Status surface
The single per-scope message a bot maintains to show what the agents are doing — who is active, the current work, task progress — edited in place rather than reposted.
*Avoid:* billboard.

A status surface echoes the prompt and may name other bots, so it is always sent with mentions suppressed; its echoed handles must stay inert so they never re-trigger the named bots (the mention cascade).

### Scribe
The single bot elected to own and compact a scope's shared Status surface, so co-resident and cross-machine bots do not each post a competing copy.

### Gate
The inbound decision pipeline every message passes before a bot acts on it: it drops duplicates, enforces the allowlist and rate cap, decides whether this bot is addressed, and stands the bot down for messages directed elsewhere or for unaddressed Peer bot noise.
