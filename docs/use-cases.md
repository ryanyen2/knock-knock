1.🤝 Cross-team feature work — repo/project level agent

Setup: Alice (#payments, her repo) and Bob (deploy-bot, his infra repo) share a Discord server. Each ran bun setup.ts → agent + room + ask-per-edit preset, exchanged bot IDs, registered each other as peers.

Steps:
1. Alice types @deploy-bot the new webhook needs an env var in staging — can you wire it?
2. A thread auto-opens (named from the prompt); Alice's message gets 👀.
3. deploy-bot (on Bob's machine) reads Bob's config files (auto-approved reads), then needs to edit staging.yaml → an approval card posts in the thread, pinging Bob.
4. Bob taps ✅ Allow from his phone (preview shows the exact diff). Alice can't approve it — it's Bob's machine, Bob's call.
5. deploy-bot replies in-thread with what it changed; an attribution line shows "traced from @Alice · 3 tools · approved by @Bob."
6. Original message swaps 👀 → 🏁.

Why it sells: two people, two machines, one task, zero shared credentials. "Nobody handed anyone the keys."

---
2.🔀 Concurrent edits → conflict card — the "wow, it handles chaos" beat

Setup: Bob's deploy-bot and Bob's other agent both touch report.md (or both agents in a room edit the same anchor).

Steps:
1. Two equal-role edits land at the same file.
2. A 🔀 conflict card posts: "Two drafts of report.md — pick one or write the merge" with Take A / Take B / Write my own.
3. File owner taps Take A (or writes a merge). The losing draft isn't deleted — it's superseded in the ledger, and that agent's owner gets a 🔁 override DM showing what won.

Why it sells: demonstrates the append-only ledger viscerally — "nothing is ever lost, only superseded." 

---
3.📥 General-purpose agent across many repos — start warm, not cold

Setup (the "general bot", not a repo-level one): Alice runs bun setup.ts → one agent, dev-bot, runtime claude-sdk. Instead of pinning it to a single repo she points its workspace at a parent folder — ~/work — that holds several projects and loose files: ~/work/api, ~/work/web, ~/work/infra, ~/work/notes. But she doesn't hand it the whole tree: the permission profile auto-allows reads only in the folders she's actively in — allow: ["Read(~/work/api/**)", "Read(~/work/web/**)"] — and ask-per-edit for writes. Anything outside that set (infra/, notes/, …) is unmatched, so it falls to ask. Room #team-room; Alice registers teammate Bob as a human. The point: the bot can reach across ~/work, but starts with least privilege and has to ask before straying into a folder it wasn't given.

Steps:
1. Alice has spent the morning in a local Claude Code session untangling an auth migration that touches ~/work/api. In a task thread: share session → a 📥 picker card lists recent local sessions (Claude Code / Codex / OpenCode / Gemini) with date + turn count + title → Alice picks it → a distilled brief (plan, decisions, files touched, dead-ends) is injected into the next turn.
2. Alice: @dev-bot using that context, does the web app still call the old auth endpoint? Both api/ and web/ are pre-allowed, so dev-bot reads across the two repos in one turn (no prompts) and finds a stale call in ~/work/web.
3. Bob jumps into the same thread: @dev-bot and grep ~/work/infra for the rollout date. infra/ isn't in the allow list → instead of silently failing, dev-bot requests access and an approval card posts pinging Alice (the owner, not Bob). Alice taps ✅ and the bot reads infra/ just for this — access broadened on demand, by the owner, one folder at a time.
4. The whole investigation — warm-started from Alice's local session, expanding from two pre-allowed repos into a third only with her approval, carried by two people — lives in one thread as the audit trail.

Why it sells: the counterpart to scenario 1's repo-level bot — one general-purpose agent that can reach files in different places, but ships locked down and earns each new folder through an owner's tap. Reach without a blank cheque. Two humans, many repos, one thread.

---
4.📊 Collaborative data analysis from your phone — multi-human, multi-agent

Setup: a product team shares #data-room. Three humans, two bots on two machines:
- Alice (analyst) owns analysis-bot — workspace ~/warehouse-exports (the warehouse CSVs/notebooks), preset strict (read-only + bash-ask).
- Bob (data engineer) owns pipeline-bot — workspace the ETL repo, preset strict (reads + git log; exec gated).
- Cindy (PM) is a human in the room with no bot of her own — she just asks and reads. analysis-bot and pipeline-bot are registered as peers.

Steps:
1. From the couch, Cindy: @analysis-bot which cohort had the biggest week-4 retention drop?
2. A thread opens; analysis-bot (Alice's machine) reads the CSVs (auto), wants to run a python script → approval card pings Alice, not Cindy. Alice taps ✅ from her phone (command preview shown). (It actually does not need approval for safe scripts if predefined)
3. analysis-bot replies: "Nov-signup cohort, −12pts" and cites the file. Attribution line: "traced from @Cindy · 2 tools · approved by @Alice."
4. Cindy follows up in the same thread: could that be the ETL change last week? @pipeline-bot did anything touch the retention job?
5. pipeline-bot (Bob's machine) reads the ETL repo + recent commits, replies that a join condition changed on the 14th — Bob approved its one git command. Now both findings sit in one thread.
6. Cindy reacts 🧷 checkpoint to pin the conclusion; the whole investigation — who asked, which machine answered, who approved — is the ledger's audit trail. Next week: @analysis-bot compare to this week resumes the same thread's session.

Why it sells: a non-software domain where three people and two machines reach a shared conclusion together — yet each owner only ever approves work on their own data. The PM drives the whole thing from her phone without touching anyone's terminal.

---
5. ⏳  Watches — deferred work, picked up by a teammate

Setup: Alice (Berlin) and Bob (San Francisco) share #deploy-room. Alice owns deploy-bot (workspace the service repo); Bob is a registered human in the room. A long migration job is about to run.

Steps:
1. End of Alice's day, in a task thread: @deploy-bot once the migration job exits, verify the row counts and summarize. She arms a watch — !watch migration on-exit ./run-migration.sh — and the turn parks. No held connection, no polling; Alice logs off.
2. Hours later the migration finishes. The relay auto-re-prompts deploy-bot, which runs the read-only verification (in its allow list, so no approval needed while Alice's offline) and posts the summary into the same thread.
3. Bob, just starting his day, sees the summary and replies in-thread: @deploy-bot the orders count looks low — dig into the last batch. He drives Alice's bot because he's allowed in the room; reads flow freely, and any write would still ping Alice for approval — the boundary holds across the handoff.
4. One thread tells the whole story: Alice armed it, the world resumed it, Bob carried it on — across two people and two timezones, with the ledger as the continuous record.

Why it sells: a task survives its owner going offline and is handed to a teammate without anyone re-explaining context — "your agent waits on the world, and your team waits on no one."

---
6.🔒 The safety story — the trust close

A fast montage rather than a full scenario:
- Someone asks the bot to rm -rf → hard deny floor, auto-rejected, no prompt ever appears.
- A peer tries to approve their own request → "Not authorized."
- Per-actor tiers: owner runs auto, peers forced to strict.
- ACP OS sandbox: writes confined to workspace, network off.
- React 🛑 mid-run → turn aborts cleanly.

Why it sells: answers the "isn't letting agents loose terrifying?" objection head-on. End on it.
