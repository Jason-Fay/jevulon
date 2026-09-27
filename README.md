# JEVULON VII (JVII)

[![npm version](https://img.shields.io/npm/v/jevulon.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/jevulon)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-amber.svg?style=flat-square)](https://nodejs.org/)

**The deterministic, self-healing control layer for parallel AI coding agents.**

JEVULON VII replaces slow, token-hungry LLM supervisor chatrooms with **instant sub-second System-1 decision gates** and a **shared stigmergic coordination whiteboard** (`board.json`). Run Claude Code, Cursor, Codex, and LangGraph agents in true parallel without merge collisions or file overwrites.

---

## Quickstart

You don't need an account or API key to start coordinating agents locally.

### 1. Run via npx
```bash
npx -y jevulon
```

### 2. Connect to Cursor or Claude Desktop (MCP)
Add JEVULON VII to your `claude_desktop_config.json` or Cursor MCP settings:

```json
{
  "mcpServers": {
    "jvii": {
      "command": "npx",
      "args": ["-y", "jevulon"]
    }
  }
}
```

Once connected, your agents automatically gain access to the coordination tools:
* `sentinel_presence` — Claims files before editing and checks for workspace collisions.
* `sentinel_shield_inspect` — Deterministic zero-latency policy floor guarding destructive commands.
* `sentinel_supervise` — Autonomous wave dispatch, worker recovery, and completion verification.

---

## Architecture: System-1 vs. System-2

Most multi-agent frameworks use **System-2 LLM supervisors** (chatty conversational models like GPT-4 or Claude 3.5 Sonnet) to coordinate workers. This burns thousands of tokens per minute, takes 10–15 seconds per coordination turn, and frequently hallucinates file states.

JEVULON VII decouples execution into two specialized layers:

```text
┌────────────────────────────────────────────────────────┐
│  SYSTEM-2 WORKERS (Claude Code, Cursor, Codex)         │
│  Thinks, plans, and writes code inside your workspace  │
└───────────────────────────┬────────────────────────────┘
                            │ (Claims files / Asks gates)
                            ▼
┌────────────────────────────────────────────────────────┐
│  SYSTEM-1 CONTROL LAYER (JEVULON VII)                  │
│  ● Deterministic file locking (board.json)             │
│  ● Zero-latency offline safety floor (0ms)             │
│  ● Sub-second categorical decision gates (~500ms)      │
│  ● $0 wasted on supervisor conversation                │
└────────────────────────────────────────────────────────┘
```

---

## Core Capabilities

### 1. Deterministic Conflict Prevention
Before an agent edits any file, it registers an atomic claim on the shared board. If sibling agents attempt to modify overlapping files or dependent interfaces, JEVULON VII negotiates priority and prevents overwriting code before it happens.

### 2. Zero-Egress Offline Safety Floor
A 77-case deterministic safety engine blocks destructive shell commands (`rm -rf`, raw disk wipes, credential exfiltration, base64 payload piping) locally in **0ms** without sending your code to any external network.

### 3. Native LangGraph Drop-in Integration
Integrate directly into LangGraph StateGraphs as a supervisor, router, or safety middleware without restructuring your workflow:

```typescript
import { createSupervisorNode, createShieldMiddleware } from "jevulon/langgraph";

// Add zero-token deterministic safety middleware to your graph
const shieldMiddleware = createShieldMiddleware({
  onBlock: "halt",
  onEscalate: "human_review"
});
```

### 4. Pluggable Decision Seam (BYOK)
Implements a structural `DecisionEngine` seam (`choice` and `noul` in `src/engine.ts`). Connect your own TypeSafe JEV keys, local Ollama/vLLM models, or use the built-in deterministic simulation engine.

---

## Enterprise & Private VPC Deployment

For enterprise teams with strict compliance or zero-external-egress mandates, a pre-hardened multi-container Docker Compose bundle is available:

**[https://github.com/Jason-Fay/jevulon-docker](https://github.com/Jason-Fay/jevulon-docker)**

```bash
curl -sSL https://jevulon.com/deploy/docker.tar.gz | tar -xz && docker compose up -d
```

---

## Testing & Verification

JEVULON VII maintains a rigorous test suite covering the deterministic floor, stigmergy, MCP servers, and circuit breakers:

```bash
git clone https://github.com/Jason-Fay/jevulon.git
cd jevulon
npm install
npm test
```

---

## License

MIT © 2026 MetaWave / Jason Fay. See [LICENSE](./LICENSE) for details.
