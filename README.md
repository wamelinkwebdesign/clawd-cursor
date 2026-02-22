<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>AI Desktop Agent via VNC — Two Execution Modes</strong><br>
  Native Computer Use for complex tasks · Action Router for instant simple ones
</p>

<p align="center">
  <a href="https://clawdcursor.com">Website</a> · <a href="#quick-start">Quick Start</a> · <a href="#how-it-works">How It Works</a> · <a href="#api-endpoints">API</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What's New in v0.3.1

**SKILL.md security hardening** — added YAML frontmatter, explicit credential declarations, privacy disclosure, and security considerations for ClaWHub publishing.

## v0.3.0

**Performance optimizations across the pipeline** — ~70% faster task execution, 90% fewer redundant LLM calls on static screens.

- **Screenshot hash cache** — skips LLM calls when the screen hasn't changed
- **Adaptive VNC frame wait** — captures in ~200ms instead of fixed 800ms
- **Parallel screenshot + accessibility fetch** — runs concurrently via Promise.all
- **Accessibility context cache** — 500ms TTL eliminates redundant PowerShell queries
- **Async debug writes** — no longer blocks the event loop
- **Exponential backoff with jitter** — better retry resilience for API calls
- **Onboarding fixes** — setup.ps1 curly quote bug fixed, admin elevation handled gracefully, SKILL.md added for OpenClaw integration

### v0.2.0

**Anthropic's Computer Use API is now the primary execution path.** The full task goes directly to Claude with native `computer_20250124` tools — no decomposition, no routing. Claude sees the screen, plans multi-step sequences, and executes them natively.

The original Action Router (UI Automation, zero LLM) is still available as a fast, cheap path for simple tasks.

| | Path A: Computer Use | Path B: Action Router |
|---|---|---|
| Provider | `--provider anthropic` | `--provider openai` / offline |
| How it works | Claude sees screenshots, plans, and acts natively | Parse → subtasks → UI Automation → vision fallback |
| Best for | Complex multi-app workflows | Simple single-action tasks |
| Speed | ~90–190s (complex tasks) | ~2s (simple tasks) |
| Reliability | Very high | Good for supported patterns |
| Cost | Higher (API calls w/ screenshots) | Lower (1 text call or zero) |
| Offline | No | Yes |

---

## What is this?

Your AI connects to your desktop via VNC — like a remote user. Depending on the provider, it either:

**Path A — Computer Use API (Anthropic):** Claude receives the full task, takes screenshots of your desktop, and executes actions natively through the `computer_20250124` tool. It plans multi-step sequences, handles errors, and verifies results — all within a single conversation loop.

```
User: "Open Chrome, go to Google Docs, write a paragraph about dogs"

  Claude sees the desktop → plans the sequence → executes step by step
  14 API calls · 187s · All steps verified
```

**Path B — Decompose + Action Router (OpenAI/Offline):** The original approach. A text-only LLM call breaks the task into subtasks. The Action Router handles each one via Windows UI Automation (no screenshots, no vision). If the router can't handle a step, it falls back to vision.

```
User: "Open Notepad"

  1. Parse → 1 subtask (text LLM, fast)
  2. Action Router → find Notepad via UI Automation, launch it (no LLM)
  
  Total LLM calls: 1 (just parsing) · ~2s
```

## Quick Start

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor
npm install && npm run build
```

Set up your `.env`:
```env
AI_API_KEY=sk-ant-api03-...
VNC_PASSWORD=yourpass
AI_PROVIDER=anthropic
```

Run with Computer Use (recommended):
```bash
npm start -- --vnc-password yourpass --provider anthropic
```

Run with Action Router (fast/offline):
```bash
npm start -- --vnc-password yourpass --provider openai
```

Send a task:
```bash
curl http://localhost:3847/task -d '{"task": "Open Notepad and type hello world"}'
```

### Windows One-Command Setup

```powershell
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The setup script downloads TightVNC, installs deps, builds TypeScript, and creates `.env`.

## How It Works

### Path A — Computer Use API

When `--provider anthropic` is set, the entire task is sent to Claude along with the `computer_20250124` tool definition. Claude:

1. Takes a screenshot of the desktop
2. Plans the next action (click, type, key press, scroll, drag)
3. Executes via VNC
4. Waits with adaptive delays (1000ms app launch, 800ms navigation, 100ms typing)
5. Receives verification hint, screenshots again
6. Repeats until the task is complete

Key details:
- **Display**: Scaled to 1280×720 for API compatibility
- **Model**: `claude-sonnet-4-20250514`
- **Header**: `anthropic-beta: computer-use-2025-01-24`
- **System prompt**: Planning rules, ctrl+l for URLs, recovery strategies
- **Mouse drag**: Smooth interpolation between points

### Path B — Decompose + Action Router

The original v0.1.0 pipeline:

1. **Decompose** — Single text-only LLM call breaks the request into atomic subtasks
2. **Action Router** — Queries Windows UI Automation tree. Finds elements by name, invokes them directly. Zero LLM calls.
3. **Vision Fallback** — Only when the router can't handle a step: screenshot → vision LLM → coordinates → click

## Architecture

```
┌──────────────────────────────────────────────────┐
│               Your Desktop (VNC Server)          │
└──────────────────────┬───────────────────────────┘
                       │ VNC Protocol
┌──────────────────────┴───────────────────────────┐
│              Clawd Cursor Agent                   │
│                                                   │
│  ┌─────────────┐          ┌────────────────────┐ │
│  │  PATH A      │          │  PATH B            │ │
│  │  Computer    │          │  Decompose +       │ │
│  │  Use API     │          │  Action Router     │ │
│  │              │          │                    │ │
│  │  Claude sees │          │  Parse → subtasks  │ │
│  │  screen,     │          │  UI Automation     │ │
│  │  plans, acts │          │  (no LLM)          │ │
│  │  natively    │          │  Vision fallback   │ │
│  └──────┬───────┘          └────────┬───────────┘ │
│         │ --provider anthropic      │ --provider  │
│         │                           │ openai      │
│         └───────────┬───────────────┘             │
│                     ↓                             │
│              Safety Layer                         │
│              REST API / CLI                       │
└───────────────────────────────────────────────────┘
```

## Test Results (v0.3.0 — Computer Use)

| Task | Time | API Calls | Result |
|------|------|-----------|--------|
| Open Chrome → Google Docs → write a paragraph | 187s | 14 | ✅ |
| Open Chrome → GitHub profile → screenshot | 102s | — | ✅ |
| Open Notepad → write haiku → save to desktop | ~180s | — | ✅ |
| Open Paint → draw stick figure | ~90s | 16 | ✅ |

## API Endpoints

`http://localhost:3847`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/task` | POST | Execute a task: `{"task": "Open Chrome"}` |
| `/status` | GET | Agent state and current task |
| `/confirm` | POST | Approve/reject pending action |
| `/abort` | POST | Stop the current task |

## Manual Setup

If you prefer manual setup over the automated script:

### 1. Install Dependencies

```bash
npm install
npm run build
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `VNC_PASSWORD` | **Yes** | Password for your VNC server | `mysecret123` |
| `AI_API_KEY` | **Yes** for AI path | Anthropic or OpenAI API key | `sk-ant-api03-...` |
| `AI_PROVIDER` | No | AI provider: `anthropic` or `openai` | `anthropic` |
| `VNC_HOST` | No | VNC server hostname/IP | `localhost` |
| `VNC_PORT` | No | VNC server port | `5900` |
| `ANTHROPIC_API_KEY` | No | Specific Anthropic API key (overrides AI_API_KEY) | `sk-ant-...` |
| `OPENAI_API_KEY` | No | Specific OpenAI API key (overrides AI_API_KEY) | `sk-...` |

**Note:** At minimum, you need `VNC_PASSWORD` set. For AI-powered desktop automation, also set `AI_API_KEY`.

### 3. Start the Agent

```bash
npm start -- --vnc-password yourpass
```

## Configuration

### CLI Options

```
--vnc-host <host>      VNC server host (default: localhost)
--vnc-port <port>      VNC server port (default: 5900)
--vnc-password <pass>  VNC password
--port <port>          API port (default: 3847)
--provider <provider>  anthropic (Computer Use) | openai (Action Router)
--model <model>        Vision model
--api-key <key>        AI provider API key
```

### Environment Variables

All CLI options can be set in `.env`:

```env
AI_API_KEY=sk-ant-api03-...
VNC_HOST=localhost
VNC_PORT=5900
VNC_PASSWORD=yourpass
AI_PROVIDER=anthropic
AI_MODEL=claude-sonnet-4-20250514
```

## Safety Tiers

| Tier | Actions | Behavior |
|------|---------|----------|
| 🟢 Auto | Navigation, reading, opening apps | Runs immediately |
| 🟡 Preview | Typing, form filling | Logs before executing |
| 🔴 Confirm | Sending messages, deleting, purchases | Pauses for approval |

## Prerequisites

- **Node.js 20+**
- **VNC Server** — [TightVNC](https://www.tightvnc.com/) (Windows), built-in Screen Sharing (macOS), `x11vnc`/`tigervnc` (Linux)
- **PowerShell** (Windows) — for UI Automation features (Path B)
- **AI API Key** — Anthropic recommended for Computer Use (Path A). OpenAI optional for Path B. Works offline for common tasks via Action Router.

## Tech Stack

TypeScript · Node.js · rfb2 (VNC) · sharp (screenshots) · Express + WebSocket · Anthropic Computer Use API · Windows UI Automation via PowerShell

## ClaWHub

Coming soon to ClaWHub — install with `openclaw skills install clawd-cursor`

## License

MIT

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
