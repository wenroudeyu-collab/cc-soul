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
| **Personality** | Same robotic tone | 10 natural styles that blend by context |
| **Emotions** | Ignores your mood | 5-dimension emotion model, adjusts in real time |
| **Learning** | Repeats the same mistakes | Learns from every correction, verifies before accepting |
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

You:  "That's wrong, the default port is 5432 not 3306"
AI:   Checks its knowledge first. If you're right → admits mistake.
      If you're wrong → counters with evidence. Never blindly accepts.

You:  "privacy mode"
AI:   "Privacy mode on. Nothing from this conversation will be stored."

You:  "pin memory Python"
AI:   Pins that memory permanently — it will never decay or be evicted.

You:  "remind 9:00 check email"
AI:   "Reminder set: every day at 9:00 — check email."
```

---

## 168 Features in 22 Categories

### Memory Engine (18)
Semantic tag recall · BM25 + trigram fuzzy search · graph-enhanced query expansion · auto-merge duplicates · daily contradiction scan · predictive recall · associative recall · session summaries · 3-tier time decay (HOT/WARM/COLD) · entity time-series with auto-expiry · CRUD decision engine (dedup at 0.7) · core memory pinning · working memory isolation · active memory management · archival reactivation · multi-route scoring (tag×1.0 + trigram×0.5 + BM25×0.7) · OpenClaw hybrid recall (FTS5) · Chain-of-Thought memory (stores reasoning process)

### Memory Commands (8)
Pin/unpin memory · search memory · delete memory · export memories (JSON) · import memories (auto-dedup, supports cc-soul/Mem0/ChatGPT/Character Card formats) · memory health audit · auto-cleanup · semantic versioning (keeps history on update)

### Knowledge Graph (6)
Entity extraction + relation modeling · persistent graph database · temporal relations (validFrom/validUntil) · BFS graph walk recall · entity summary generation · path queries between entities

### Cognitive Pipeline (8)
3-stage attention gate · intent prediction · strategy selection · atmosphere sensing · frustration detection · implicit feedback recognition · adaptive reasoning depth (auto-adjusts by complexity) · Graph-of-Thoughts multi-path reasoning

### Personality System (8)
10 auto-switching personas (engineer, friend, mentor, analyst, comforter, strategist, explorer, executor, teacher, devil's advocate) · smooth persona blending · per-user style preference learning · drift detection (Welford + 3σ) · drift warning · bidirectional emotional contagion · relationship dynamics · persona usage tracking with growth curve

### Body Simulation (8)
Energy management · mood model · PADCN 5-dimension emotion vector (Pleasure/Arousal/Dominance/Certainty/Novelty) · circadian rhythm adjustment · 7-day emotional arc · weekly mood report · cognitive load tracking · trend detection

### Conversation Flow (7)
Multi-turn topic tracking · topic persistence · session end detection · privacy mode · emergency mode · proactive expansion across 22 tech + 11 life domains · reverse prompting (asks clarifying questions for ambiguous messages)

### Learning & Evolution (9)
Auto-discover rules from corrections · Bayesian hypothesis verification (Beta posterior + Wilson CI) · 5-class root cause attribution · strategy chain replay · reflection rule tracking · meta-learning insights · rule compression (auto-merge similar rules) · Chain-of-Thought memory · five-stage self-reflection loop (plan→execute→verify→solidify)

### Correction System (2)
Auto-verify corrections (checks facts before accepting or rejecting) · correction-triggered web search verification

### Inner Life (6)
Journal writing · deep reflection · dream mode · follow-up plan tracking · self-challenge on weak domains · regret tracking

### Autonomous Behavior (7)
Impulse-driven proactive messages · web roaming based on interests · weekly tech radar · autonomous goal decomposition + execution · intent-based task delegation · auto-create reusable skills · skill library lookup

### Quality System (4)
Logistic regression response scoring · AdaGrad adaptive weight learning · hard example replay · dual self-check

### Metacognition (7)
Dynamic conflict detection · augment interaction matrix · cascading conflict arbitration · sigmoid priority multiplier · difficulty-adjusted scoring · pairwise interaction effects · ghost context detection

### Pattern Learning (4)
LLM-named pattern discovery with trigram clustering · Thompson Sampling exploration · 4D matching (question type × emotion × depth × time slot) · 90-day decay

### Context Preparation (6)
File path preview · URL prefetch · code symbol grep (secure execFileSync) · stack trace parsing · hex address detection · intent prediction hint

### User Profiling (6)
Auto tier detection (owner/regular/new) · 24h rhythm tracking · gratitude tracking · 4-axis value learning · engagement analysis · familiarity auto-growth

### Knowledge (5)
Lorebook deterministic injection · epistemic calibration · RAG document ingestion (Markdown/code/paper/text) · image/screenshot memory · code pattern memory

### Self-Upgrade (7)
Module-level self-modification (5-agent pipeline) · esbuild syntax check · 3-day observation + auto-rollback · upgrade meta-learning · curiosity proposals · upgrade experience memory · tiered autonomy (low-risk auto / high-risk confirm)

### Parameter Tuning (5)
Thompson Sampling with 5-arm discretization · real-time reward tracking · A/B experiment framework · phased evolution · context-aware augment budget

### Diagnostics & Monitoring (5)
7-dimension health scan · code quality audit · module health monitoring · timeout protection · metrics command (messages, response time, recall calls)

### Network & Sync (6)
Cross-device JSONL export/import · HTTP sync to Knowledge Hub · incremental sync (only changed memories) · CRDT conflict resolution (LWW + tag union) · federated knowledge sharing · cross-user anonymous rule learning

### Security (4)
Prompt injection detection (9 regex patterns) · immutable audit log (sha256 chain) · PII filtering (email/phone/API key/IP/social accounts) · MCP rate limiting

### User Features (12)
Habit tracking + streaks · goal tracking + milestones · scheduled reminders (via heartbeat) · conversation summary · capability score display · weekly mood report · memory graph HTML visualization · export/import soul config · export Lorebook (sanitized, ClawHub compatible) · voice output (macOS say) · multi-agent orchestration prompts · new user onboarding

### Infrastructure (6)
Multi-backend AI adapter (Claude/OpenAI/Ollama/Groq/OpenRouter/Zhipu/Tongyi/Kimi) · zero-dependency SQLite + vector search with graceful fallback · full language auto-follow · new user guided onboarding · SoulSpec compatibility (soul.json + STYLE.md + IDENTITY.md + HEARTBEAT.md) · MCP tool provider (4 tools for cross-agent queries)

---

## Commands

| Command | What it does |
|---------|-------------|
| `stats` | Personal dashboard — messages, memories, quality, mood, persona growth |
| `soul state` | AI energy, mood, alertness, PADCN emotion vector |
| `features` | List all 33 feature toggles |
| `enable X` / `disable X` | Turn any feature on or off |
| `my memories` | View what AI remembers about you |
| `search memory <keyword>` | Search through memories |
| `delete memory <keyword>` | Remove matching memories |
| `pin memory <keyword>` | Pin important memory (never decays) |
| `unpin memory <keyword>` | Unpin a memory |
| `export memories` | Export all memories to JSON |
| `import memories <path>` | Import from JSON (auto-dedup, multi-format) |
| `export soul` | Export soul config for sharing |
| `import soul <path>` | Import soul config |
| `export lorebook` | Export knowledge base (sanitized) |
| `ingest <path>` | Import document to memory (Markdown/code/text/paper) |
| `knowledge map` | Visualize knowledge graph (Mermaid) |
| `memory map html` | Generate interactive HTML visualization |
| `memory health` | Memory count, distribution, confidence, decay stats |
| `memory audit` | Find duplicates, short entries, untagged memories |
| `metrics` | System monitoring — messages, response time, recall calls |
| `conversation summary` | Recent session summaries |
| `mood report` | 7-day emotional trend report |
| `capability score` | Domain confidence scores |
| `privacy mode` | Pause all memory storage |
| `checkin <habit>` | Track a habit |
| `habits` | View habit streaks |
| `new goal <desc>` | Create a goal |
| `my goals` | View goals and progress |
| `remind HH:MM <msg>` | Set daily reminder |
| `my reminders` | List reminders |
| `audit log` | View immutable audit trail |
| `read aloud <text>` | Voice output (macOS) |

---

## What Makes cc-soul Different

Features no other AI memory plugin has:

| Feature | What it does |
|---------|-------------|
| **Proactive Expansion** | You ask about a bug → AI fixes it, then warns about 3 related pitfalls you didn't ask about |
| **Correction Verification** | When you say "that's wrong", AI checks facts first — admits if wrong, counters with evidence if right |
| **Dream Mode** | Replays memories during idle time, discovers unexpected cross-domain connections |
| **Self-Upgrade** | 5 AI agents collaboratively modify their own source code, with syntax check + observation period + auto-rollback |
| **Bayesian Learning** | Forms hypotheses from corrections, tests statistically, only locks rules when confidence interval passes threshold |
| **Body Simulation** | 5-axis state (energy/mood/load/alertness/anomaly) + PADCN emotion vector — affects response style in real time |
| **Soul Fingerprint** | Monitors its own response style. If personality drifts, it detects and self-corrects |
| **Five-Stage Reflection** | plan → execute → verify → solidify — rules only become permanent after 3 successful verifications |
| **Immutable Audit Log** | SHA256 chain-linked log of all memory/rule/upgrade operations |
| **Graph-of-Thoughts** | Complex questions trigger parallel reasoning paths that merge insights |

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

## Security & Privacy

- All data stored locally — nothing leaves your machine
- Privacy mode pauses all memory storage
- PII auto-filtering before any network upload
- Prompt injection detection
- Immutable audit log (SHA256 chain)
- MCP tools rate-limited
- [SECURITY.md](https://github.com/wenroudeyu-collab/cc-soul/blob/main/SECURITY.md)

---

## Vector Search (Optional)

cc-soul works out of the box with keyword-based search (TF-IDF + trigram). For better recall, you can enable **semantic vector search** — it understands meaning, not just keywords.

### With vs Without

| You ask | Without vector | With vector |
|---------|---------------|-------------|
| "that deployment thing we discussed" | ❌ Can't find it (no word "deployment" in memory) | ✅ Finds "server on Alibaba Cloud, SSH port 22" |
| "the bug from last week" | Only finds memories containing "bug" | Finds related memories about errors, crashes, fixes |
| "what did I say about performance" | Exact keyword match only | Understands performance ≈ speed, latency, optimization |

**Without vector (default):** keyword matching — works well for < 10,000 memories.
**With vector:** semantic understanding — recommended for 10,000+ memories or when you want "fuzzy" recall.

### How to Enable

Download the embedding model (~90MB) and place it in the data directory:

```bash
mkdir -p ~/.openclaw/plugins/cc-soul/data/models/minilm
cd ~/.openclaw/plugins/cc-soul/data/models/minilm
curl -L -o model.onnx "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx"
curl -L -o vocab.json "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"
```

Restart gateway. You should see in logs:
```
[cc-soul][embedder] ready — all-MiniLM-L6-v2 (384d, CPU)
[cc-soul][memory] embedder ready — vector search enabled
```

No configuration needed. If the model files are present, vector search activates automatically. If not, cc-soul silently falls back to keyword search — nothing breaks.

---

## Feedback

- **Issues & Feature Requests**: [github.com/wenroudeyu-collab/cc-soul/issues](https://github.com/wenroudeyu-collab/cc-soul/issues)
- **Email**: wenroudeyu@gmail.com

---

[npm](https://www.npmjs.com/package/@cc-soul/openclaw) · [GitHub](https://github.com/wenroudeyu-collab/cc-soul)

*Not a chatbot. A companion that remembers, reflects, and grows.*
