---
name: cc-soul
description: "Your AI, but it actually knows you — persistent memory, adaptive personality, emotional awareness"
version: 2.5.1
author: wenroudeyu-collab
homepage: https://github.com/wenroudeyu-collab/cc-soul-docs
metadata: {"requires":{"env":[],"bins":[],"install":[{"cmd":"npm install @cc-soul/openclaw","when":"after-clone"}]}}
tags:
  - soul
  - memory
  - personality
  - cognitive
  - emotion
  - agent
---

# cc-soul — Your AI, But It Actually Knows You

Persistent memory across sessions, 11 adaptive personas, emotional awareness, and correction-based learning. One command install, zero configuration, all data stored locally.

## Key Features

- **Persistent Memory** — remembers facts across sessions with semantic search and contradiction detection
- **11 Adaptive Personas** — engineer, friend, mentor, analyst, comforter, strategist, explorer, executor, teacher, devil's advocate, socratic — auto-selected by context
- **Socratic Mode** — say "帮我理解" and it stops giving answers, asks questions instead
- **Emotional Awareness** — detects mood, tracks 7-day arc, adjusts response style
- **Correction Learning** — extracts rules from corrections, verifies over 3 conversations before accepting
- **Knowledge Graph** — entities and relationships visualized as interactive diagrams
- **Vector Search** — optional local embedding model (~90MB) for semantic recall
- **Config Backup** — save and restore preferences as local JSON files

## Install

```bash
openclaw plugins install @cc-soul/openclaw
```

## Source Code Audit

This ClawHub package includes 17 TypeScript source files in `src/` for transparency. These are the plugin's infrastructure modules — you can verify:

| File | What you can verify |
|------|-------------------|
| `plugin-entry.ts` | Plugin registration — writes openclaw.json (plugin allow-list) + workspace/SOUL.md (prompt injection) |
| `persistence.ts` | All file I/O — writes to `~/.openclaw/plugins/cc-soul/data/` and `~/.openclaw/workspace/` |
| `features.ts` | All feature toggles — confirms what can be enabled/disabled |
| `types.ts` | All data structures — confirms what data is stored |
| `mcp-provider.ts` | MCP tools exposed — confirms rate limiting and scope |
| `sqlite-store.ts` | Database operations — confirms local SQLite only |
| `audit.ts` | Audit log — confirms SHA256 chain-linked logging |
| `brain.ts` | Module system — confirms how modules are loaded and isolated |
| `cli.ts` | CLI calls — spawns your configured AI CLI for background tasks (tagging, reflection) |
| `embedder.ts` | Vector model — user-initiated download from HuggingFace, then local-only inference |
| `health.ts` | Health checks — confirms no external calls |
| `notify.ts` | Notifications — confirms console.log only by default |
| `handler-state.ts` | State management — confirms in-memory only |
| `hook-handlers.ts` | Hook bridge — confirms OpenClaw standard hooks |
| `cost-tracker.ts` | Token tracking — confirms local counting only |
| `signals.ts` | Signal detection — confirms rule-based, no LLM calls |
| `utils.ts` | Utility functions — confirms no I/O or network |

Core algorithm modules (memory engine, persona selection, cognition pipeline, emotion model) are distributed via npm as obfuscated JS — these contain the proprietary logic but all I/O goes through the auditable modules above.

## What This Plugin Does

- **Stores memory data** in `~/.openclaw/plugins/cc-soul/data/` — JSON and SQLite files
- **Writes `~/.openclaw/openclaw.json`** — registers plugin path and allow-list entry (standard OpenClaw plugin registration, see `plugin-entry.ts` L106-171)
- **Writes `~/.openclaw/workspace/SOUL.md`** — injects personality/memory context into agent prompt (see `plugin-entry.ts` L43-56). This is how the AI "knows" you — without it the plugin has no effect
- **Invokes your configured AI CLI** — background tasks (tagging, reflection) call the agent CLI from your OpenClaw settings (e.g. `claude -p`). Uses your existing API keys, does not manage credentials directly (see `cli.ts`)
- **Optionally downloads embedding model** — if user runs `安装向量` / `install vector`, downloads MiniLM model (~90MB) from HuggingFace to local disk. This is the only network call, user-initiated, one-time (see `embedder.ts`)
- **Reads local documents** when user runs `ingest <path>` — only files explicitly specified by user
- **Does NOT phone home** — no telemetry, no analytics, no data sent to cc-soul servers or any third party
- **Does NOT access system files** — no keychain, no credentials, no directories outside `~/.openclaw/`

## What Users Can Verify

- Read `src/` in this package to audit all I/O and network behavior
- Run `ls ~/.openclaw/plugins/cc-soul/data/` to see all stored data
- Run `cat ~/.openclaw/plugins/cc-soul/data/memories.json` to read all memories
- Say "privacy mode" to pause all memory storage
- Say "audit log" to see SHA256 chain-linked operation log
- Run `npm audit` on the installed package

## Links

[npm](https://www.npmjs.com/package/@cc-soul/openclaw) | [GitHub](https://github.com/wenroudeyu-collab/cc-soul-docs) | [Issues](https://github.com/wenroudeyu-collab/cc-soul-docs/issues)
