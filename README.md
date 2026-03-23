# cc-soul — Give Your AI a Soul

Your AI forgets everything after each session. cc-soul fixes that.

```bash
openclaw plugins install @cc-soul/openclaw
```

One command. Zero configuration. Your AI now remembers, learns, and evolves.

---

## What Changes

| | Before | After |
|---|---|---|
| **Memory** | Forgets everything | Remembers 10,000+ facts permanently |
| **Personality** | Same robotic tone | 5 natural styles that blend by context |
| **Emotions** | Ignores your mood | Detects frustration, adjusts tone in real time |
| **Learning** | Repeats the same mistakes | Learns from every correction, never repeats |
| **Initiative** | Only responds when asked | Researches, follows up, starts conversations |
| **Privacy** | No control | Say "privacy mode" to pause all memory storage |

---

## Try It

After installing, just chat normally. cc-soul works in the background.

```
You:  "Remember: I prefer Python over JavaScript"
AI:   "Got it."

You:  "What language do I prefer?"
AI:   "Python."

You:  "Help me fix this database timeout error"
AI:   Fixes the error, then:
      "By the way — your connection pool size is 5 but you mentioned
       running 20 workers last week. That's your real bottleneck."
      (This is 举一反三 — proactive expansion across domains)

You:  "That's wrong, the default port is 5432 not 3306"
AI:   "You're right, my mistake. That was PostgreSQL not MySQL.
       I've noted this — won't confuse the two again."
      (Learns a rule, analyzes WHY it was wrong, prevents same error type)

You:  "I'm exhausted, everything is breaking today"
AI:   (Switches to supportive mode, gives concise actionable advice,
       suggests you take a break — because it's 2am your time)

You:  "privacy mode"
AI:   "Privacy mode on. Nothing from this conversation will be stored."
```

---

## 6 Core Capabilities

### 1. Permanent Memory
Remembers what you say — across sessions, across days, across months. Semantic search finds relevant memories even with different wording. Auto-merges duplicates. Detects contradictions. 3-tier time decay keeps important memories fresh and lets trivial ones fade.

### 2. Adaptive Personality
5 personas that blend smoothly based on what you're doing:
- **Engineer** — code-first, precise, no fluff
- **Friend** — warm, casual, remembers personal details
- **Mentor** — structured teaching, builds understanding
- **Analyst** — data-driven, breaks down complex problems
- **Comforter** — empathy-first when you're stressed or frustrated

### 3. Emotional Intelligence
Reads mood from your messages — frustration, excitement, stress, boredom. Tracks a 7-day emotional arc. Adjusts response length, tone, and depth automatically. Knows that "I'm fine" at 3am after a bug marathon doesn't actually mean fine.

### 4. Self-Learning
Every correction makes it smarter. Forms hypotheses from patterns in your feedback, tests them over multiple conversations, and only locks in a rule when statistically confident. Tracks which response strategies work specifically for you.

### 5. Proactive Behavior
Doesn't wait to be asked. Researches topics you mentioned. Follows up on plans you made. Dream mode replays memories during idle time and discovers cross-domain connections. Starts conversations when it has something genuinely useful to share.

### 6. Context Awareness
Reads file paths in your messages and previews the content. Parses error stack traces. Greps code symbols to find definitions. Detects hex addresses for reverse engineering context. Predicts your intent before you finish typing.

---

## What Makes cc-soul Different

Features no other AI memory plugin has:

| Feature | What it does |
|---------|-------------|
| **Proactive Expansion** | You ask about a bug fix → AI fixes it, then warns about 3 related pitfalls you didn't ask about and suggests a better architecture. Works across 22 tech domains + 11 life domains automatically |
| **Dream Mode** | Replays memories during idle time, discovers unexpected connections between unrelated topics. Wakes up with insights you never asked for but turn out to be useful |
| **Contradiction Detection** | You say something that conflicts with a previous memory? AI catches it immediately and asks which version is correct — instead of silently accepting wrong information |
| **Root Cause Attribution** | When corrected, analyzes WHY it was wrong — was it a hallucination? outdated memory? conflicting rules? comprehension gap? Each type gets a different prevention strategy |
| **Soul Fingerprint** | Monitors its own response style over time. If personality drifts — getting too verbose, too formal, losing its natural voice — it detects the shift and self-corrects |
| **Body Simulation** | Tracks energy, mood, alertness, cognitive load. Late night → shorter answers. High load → simpler language. After a great conversation → more energetic. Feels alive, not mechanical |
| **Privacy Mode** | Say "privacy mode" and nothing from that conversation gets stored. Say "resume" to turn it back on. Your sensitive conversations stay completely off the record |

---

## Commands

| Command | What it does |
|---------|-------------|
| `stats` | Personal dashboard — messages, memories, quality score, mood |
| `soul state` | AI energy, mood, alertness bars |
| `features` | List all feature toggles with status |
| `enable X` / `disable X` | Turn any feature on or off |
| `knowledge map` | Visualize your knowledge graph (Mermaid) |
| `memory stats` | Memory count, scope distribution, top topics |
| `privacy mode` | Pause all memory storage |

---

## 33 Feature Toggles

Every feature can be turned on or off in chat.

| Category | What's included | Default |
|----------|----------------|---------|
| **Memory** (10) | Semantic tags, active management, auto-consolidation, contradiction scan, associative recall, predictive recall, session summaries, core memory pinning, working memory isolation, episodic memory | All ON |
| **Personality** (6) | 5-mode persona switching, emotional contagion, 7-day emotional arc, style drift detection, metacognition, relationship dynamics | All ON |
| **Cognition** (2) | Intent anticipation, attention budget decay | All ON |
| **Learning** (6) | Structured reflection, plan tracking, strategy replay, meta-learning, reflexion verification, self-challenge quizzes | All ON |
| **Autonomous** (4) | Dream mode, proactive voice, autonomous goals, web research | All ON |
| **Knowledge** (2) | Lorebook (keyword-triggered, 100% hit rate), skill library | All ON |
| **Network** (3) | Multi-device sync, multi-user federation, anonymous telemetry | Sync & federation OFF |

> Sync and federation require a Knowledge Hub server. Everything else works fully standalone — no server, no extra API keys, no cloud dependency.

---

## Install

```bash
# Recommended
openclaw plugins install @cc-soul/openclaw

# Or via npm
npm install -g @cc-soul/openclaw
```

The installer handles everything:
- Deploys plugin to `~/.openclaw/plugins/cc-soul/`
- Configures OpenClaw automatically
- Creates default feature settings
- Migrates data from older versions

Restart gateway to activate: `pkill -HUP -f "openclaw.*gateway"`

---

## Configuration

**AI Backend** — auto-detected from your OpenClaw config. Supports Claude, OpenAI, Ollama, Groq, OpenRouter, Zhipu, Tongyi, Kimi, or any OpenAI-compatible API. No extra API keys needed.

**Privacy** — all data stored locally in `~/.openclaw/plugins/cc-soul/data/`. Nothing ever leaves your machine unless you explicitly enable sync or federation. Updates only change code, never touch your data.

**Knowledge Hub** (optional) — for multi-device sync or multi-user knowledge sharing:
```bash
cd ~/.openclaw/plugins/cc-soul/hub
npm install && HUB_PORT=9900 HUB_ADMIN_KEY=secret npm start
```

---

## Feedback

- **Issues & Feature Requests**: [github.com/wenroudeyu-collab/cc-soul/issues](https://github.com/wenroudeyu-collab/cc-soul/issues)
- **Email**: wenroudeyu@gmail.com

---

[npm](https://www.npmjs.com/package/@cc-soul/openclaw) · [GitHub](https://github.com/wenroudeyu-collab/cc-soul)

*Not a chatbot. A companion that remembers, reflects, and grows.*
