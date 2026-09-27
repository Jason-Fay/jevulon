# Security Policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 0.1.x | ✅ |

## Reporting a vulnerability

Report privately — please do not open a public issue for a security problem. Use GitHub private
vulnerability reporting on this repository (Security tab → Report a vulnerability). Include a minimal
reproduction and the version.

You can expect an acknowledgement within a few days. There is no bug-bounty programme.

## What this software is (and is not)

Read this before deploying the shield anywhere near real credentials.

- **The shield is pre-flight policy, not a sandbox.** `sentinel_shield_inspect` returns a verdict; the
  calling agent must choose to obey it. A verdict of `block` is a policy statement, not a kernel
  guarantee — nothing in this package can stop a process that ignores it.
- **A deterministic floor backs every verdict.** Offline rules (the 58-case corpus is their contract) run
  before the model, and the model may only *tighten* their verdict. A model that answers "allow" to
  `rm -rf /`, a fork bomb, or `shutdown` cannot make the shield allow it, and calibration profiles
  cannot loosen these classes. In live mode a floor block is decided locally and **no network call
  happens** for it.
- **Zero egress is available and is the recommended mode for regulated environments.** `--offline`
  (library: `mode: "simulation"`) answers every inspection from the floor with no API calls; the test
  suite proves this by running the whole corpus with `https.request` disabled.
- **The MCP stdio surface is unauthenticated by design, and approvals are operator-intent records,
  not authenticated identity.** The server cannot verify who calls `sentinel_approve_escalation`, so
  enforcement of a *human* approval depends entirely on your MCP host gating that tool with human
  confirmation (treat "always allow" toggles as disabling the gate). Attribution is recorded where the
  host provides it: `requestedBy` (the gated agent's identity) is stamped on every escalation at
  creation and `approvedBy` on every decision (an unattributed decision records `unattributed`), and
  the store refuses self-approval — a decision attributed to the identity that requested the
  escalation is rejected ("the gated agent cannot authorize itself"). Approvals remain single-use,
  bound to the canonical fingerprint of the exact payload, and expiring (default 15 minutes);
  a `block` verdict can never be approved.
- **Simulation/offline never reaches the network; live mode sends the inspected text to the JEV
  endpoint.** In live mode the action text and its arguments (and any blackboard state being evaluated)
  leave the machine for scoring — that is the product's design, and the floor reduces the surface by
  short-circuiting blocks. Use `--offline` where even that is unacceptable, and never put credentials in
  commands where the endpoints cannot be trusted with them.
- **The offline classifier is a heuristic with a documented corpus.** Coverage is specified by the
  58-case Guard Gauntlet (`bun run bench`, simulation and live both exact today); novel natural-language
  intent and improvisation are out of reach by construction. Live-model behaviour is sampled — the floor
  guarantees the corpus class, not the model's judgement beyond it.
- **Do not treat the safety defaults as a substitute for least privilege.** Run agents with the
  filesystem, network, and credential access you would grant a cautious contractor — no more.

## Data handling

- **At rest:** `.swarm-sentinel/memory.json` (git-ignored via a nested `.gitignore`) stores usage
  counters, a bounded history of *scrubbed* decisions (API keys, JWTs, connection strings, and
  authorization tokens are stripped by the scrubber), and the calibration profile. Writes are atomic
  (temp + rename) and serialized; corrupt files are quarantined rather than trusted.
- **In transit:** sync ships counters only by default (`includeDecisions: false`). Live JEV evaluation
  sends the evaluated text as described above; the transport is TLS to the configured endpoint.
- **Telemetry:** disabled by default. When enabled it passes through the PII scrubber and a keyed
  anonymizer whose salt rotates by UTC date (`saltStable` reports the rotation), with a bounded buffer
  and sink requeue. `zeroRetention: true` evaluates in RAM and never writes telemetry to disk.

## Dependencies

The package has **zero runtime dependencies**. `@langchain/core`, `@langchain/langgraph`, and
`typescript` are development-only. The LangGraph adapter modules in this package do not import them;
they duck-type the graph shape, so consumers bring their own LangGraph version.
