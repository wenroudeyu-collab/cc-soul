---
name: cc-soul
description: "Give your AI a soul — persistent memory, adaptive personality, emotional awareness, self-evolution"
version: 2.0.0
author: wenroudeyu-collab
tags:
  - soul
  - memory
  - personality
  - cognitive
  - evolution
  - emotion
  - agent
---

# cc-soul — Give Your AI a Soul

A cognitive architecture plugin for OpenClaw that adds persistent memory, adaptive personality, and self-learning to your AI.

## How It Works

cc-soul is an OpenClaw **context-engine plugin** distributed via npm. It runs locally on your machine — no external servers, no data upload, no cloud dependency.

**Why npm instead of inline code?** cc-soul is 50 TypeScript modules (20,000+ lines). It needs a proper Node.js runtime with file I/O, SQLite, and background processing — capabilities that go beyond what a single SKILL.md file can provide. The npm package handles installation, configuration, and data migration automatically.

## What It Does

- **Permanent Memory** — remembers facts across sessions using semantic search, auto-merge, and contradiction detection
- **10 Adaptive Personas** — engineer, friend, mentor, analyst, comforter, strategist, explorer, executor, teacher, devil's advocate — auto-selected by conversation context
- **Emotional Intelligence** — detects mood from messages, tracks 7-day emotional arc, adjusts response style
- **Self-Learning** — extracts rules from corrections, tests hypotheses statistically, tracks which strategies work for you
- **Proactive Behavior** — follows up on plans, researches topics you care about, starts conversations when relevant

## Install

```bash
openclaw plugins install @cc-soul/openclaw
```

The installer automatically:
- Deploys plugin files to `~/.openclaw/plugins/cc-soul/`
- Updates `~/.openclaw/openclaw.json` (adds plugin path to `plugins.load.paths` and `cc-soul` to `plugins.allow`)
- Creates `~/.openclaw/plugins/cc-soul/data/features.json` (default feature settings, 33 toggles)
- Creates `~/.openclaw/plugins/cc-soul/openclaw.plugin.json` (plugin manifest)
- Writes `~/.openclaw/workspace/SOUL.md` (dynamic soul prompt, refreshed every 5 min)
- If upgrading: migrates data from `~/.openclaw/hooks/cc-soul/` to `~/.openclaw/plugins/cc-soul/`

**No files outside `~/.openclaw/` are modified.** No API keys needed. Auto-detects your OpenClaw AI backend.

### Why npm instead of inline code?
cc-soul is 52 TypeScript modules (22,000+ lines) that require Node.js runtime with file I/O, SQLite, and background processing. This exceeds what a single SKILL.md can provide. The npm package is published under `@cc-soul/openclaw` on the official npm registry.

## Security & Privacy

- **All data stored locally** in `~/.openclaw/plugins/cc-soul/data/` — nothing leaves your machine
- **Privacy mode** — say "privacy mode" to pause all memory storage
- **No network calls** unless you explicitly enable `federation` or `sync` (both OFF by default)
- **Updates only change code**, never touch your data
- **Telemetry is anonymous and opt-out** — `disable telemetry`
- **Open source security policy**: [SECURITY.md](https://github.com/wenroudeyu-collab/cc-soul/blob/main/SECURITY.md)

## Permissions Explained

| Permission | Why | User Control |
|-----------|-----|-------------|
| File read/write | Store memories, config, features locally | All in `~/.openclaw/plugins/cc-soul/data/` |
| Background CLI | Async tasks (tagging, analysis) without blocking the main agent | Auto-managed with 180s timeout, zero network calls |
| Web search | Only active when `web_rover` feature is explicitly enabled by user | `disable web_rover` to turn off |
| Self-upgrade | Disabled by default. Opt-in only. Requires explicit user confirmation before any code changes. Includes syntax check + 3-day observation + auto-rollback safety net | `enable self_upgrade` to opt in |

## Commands

```
features            → list all 33 toggles
enable/disable X    → turn any feature on/off
stats               → personal dashboard
soul state          → energy/mood/alertness
privacy mode        → pause memory storage
```

## Links

- **npm**: https://www.npmjs.com/package/@cc-soul/openclaw
- **GitHub**: https://github.com/wenroudeyu-collab/cc-soul
- **Issues**: https://github.com/wenroudeyu-collab/cc-soul/issues
- **Email**: wenroudeyu@gmail.com
