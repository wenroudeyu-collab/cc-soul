---
name: cc-soul
description: "Give your AI a soul — persistent memory, adaptive personality, emotional awareness"
version: 2.3.0
author: wenroudeyu-collab
tags:
  - soul
  - memory
  - personality
  - cognitive
  - emotion
  - agent
---

# cc-soul — Give Your AI a Soul

A cognitive architecture plugin for OpenClaw that adds persistent memory, adaptive personality, and self-learning to your AI.

## What It Does

- **Permanent Memory** — remembers facts across sessions using semantic search, auto-merge, and contradiction detection
- **10 Adaptive Personas** — engineer, friend, mentor, analyst, comforter, strategist, explorer, executor, teacher, devil's advocate — auto-selected by conversation context
- **Emotional Intelligence** — detects mood from messages, tracks 7-day emotional arc, adjusts response style
- **Self-Learning** — extracts rules from corrections, tests hypotheses statistically, tracks which strategies work for you

## Install

```bash
openclaw plugins install @cc-soul/openclaw
```

## Architecture — Why npm?

cc-soul is 50+ TypeScript modules implementing memory engines, cognitive pipelines, knowledge graphs, and learning algorithms. This exceeds what a single SKILL.md can contain. The npm package (`@cc-soul/openclaw`) is:

- **Published on the official npm registry** — [`npmjs.com/package/@cc-soul/openclaw`](https://www.npmjs.com/package/@cc-soul/openclaw)
- **Versioned and immutable** — each release is a fixed artifact on npm, auditable via `npm audit`
- **Documentation and security policy on GitHub** — [`github.com/wenroudeyu-collab/cc-soul`](https://github.com/wenroudeyu-collab/cc-soul)

## What the Installer Modifies

The installer makes **exactly 4 changes**, all within `~/.openclaw/`:

| File | Change | Why |
|------|--------|-----|
| `~/.openclaw/openclaw.json` | Adds plugin path to `plugins.load.paths`; adds `cc-soul` to `plugins.allow` | Required by OpenClaw plugin system to load any plugin |
| `~/.openclaw/plugins/cc-soul/data/features.json` | Creates default feature toggles (user-controllable) | Stores user preferences for which features are active |
| `~/.openclaw/plugins/cc-soul/openclaw.plugin.json` | Creates plugin manifest | Standard OpenClaw plugin descriptor |
| `~/.openclaw/workspace/SOUL.md` | Writes dynamic prompt file | Injects personality/memory context into agent |

**No files outside `~/.openclaw/` are created, modified, or read.** No system files are touched. No PATH modifications. No launch agents or daemons.

## Security & Privacy

### What This Plugin Does
- **Stores data locally** — all memory, config, and state in `~/.openclaw/plugins/cc-soul/data/`
- **Runs JavaScript code** — 50+ obfuscated JS modules execute as an OpenClaw plugin within the Node.js runtime
- **Invokes your AI backend** — background tasks (tagging, reflection, self-eval) call the agent CLI configured in your OpenClaw settings (e.g. `claude -p`). These use whatever AI provider and API keys you have already configured — cc-soul does not manage API keys or endpoints directly
- **Writes to `~/.openclaw/`** — creates plugin data files, feature configs, and a dynamic SOUL.md prompt file. No files outside `~/.openclaw/` are created or modified
- **Optionally sends notifications** — if Feishu credentials are manually configured in `data/config.json`, activity notifications are sent via Feishu API. No notifications are sent without explicit configuration

### What This Plugin Does NOT Do
- **No telemetry** — does not transmit usage data, analytics, or metrics to any third-party service
- **No phone-home** — never contacts cc-soul's own servers, npm registry, or any endpoint at runtime
- Does not modify any files outside `~/.openclaw/`
- Does not install background services, launch agents, or daemons
- Does not access system credentials or keychains

### Data Safety
- **Privacy mode** — say "privacy mode" to pause all memory storage instantly
- **PII auto-filtering** — strips emails, phone numbers, API keys, and IP addresses before storage
- **Prompt injection detection** — regex patterns protect against adversarial input
- **Immutable audit log** — SHA256 chain-linked log of all memory operations

## User Control

All features are individually toggleable via chat commands:
```
features            → list all toggles with current state
enable/disable X    → turn any feature on or off
privacy mode        → pause all memory storage
stats               → personal dashboard
soul state          → energy/mood/alertness
```

## Links

- **npm**: https://www.npmjs.com/package/@cc-soul/openclaw
- **GitHub (docs & security policy)**: https://github.com/wenroudeyu-collab/cc-soul
- **Issues & Feature Requests**: https://github.com/wenroudeyu-collab/cc-soul/issues
- **Email**: wenroudeyu@gmail.com
