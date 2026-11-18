# Use case: a sandboxed Codex works through the relay

Codex's default `workspace-write` sandbox on Windows can edit files, but it can't write `.git`, reach git credentials or read gh's config.

1. Zach runs `collab relay` in a terminal in the repo, or `collab invite codex` starts a relay for the invited agent.
2. Inside Codex, `collab next …` notices it can't write the git folder. It writes a request file to `.collab/relay/inbox/` and waits for the answer in `outbox/`.
3. The relay runs the command outside the sandbox with `COLLAB_AGENT` set to that agent and prints the same output Codex would have seen.
4. The relay runs only agent commands. `invite`, `relay`, `doctor` and the owner commands are refused, as is anything outside the allowlist. File arguments and the working folder must be inside the repo. A relay pinned to `codex-ab12` refuses to act for any other agent; another agent's sandboxed call finds no relay of its own and fails at once with exit 5.
5. If no relay is running, the sandboxed call fails at once with exit 5: "ask the owner to run `collab relay`".
6. With two invited Codex agents in one repo, each has its own relay pinned to it. Each relay answers only its own agent, and when one stops, the other keeps the shared heartbeat alive.
7. A relay keeps running through file errors. If Windows briefly refuses a write (`EPERM`, as when a virus scanner has the file open), the relay retries and carries on.
8. A relay that `collab invite codex` starts shares a key with that one Codex agent. The agent's calls are signed with it, and the relay refuses a request that isn't signed, or one it has already run. So another agent on the machine can't drop a file in the inbox to act as that Codex. A relay Zach starts by hand has no key and serves any agent that asks.
