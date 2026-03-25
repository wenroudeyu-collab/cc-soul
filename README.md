# cc-soul — Give Your AI a Soul

Your AI forgets everything after each session. cc-soul fixes that.

```bash
openclaw plugins install @cc-soul/openclaw
```

One command. Zero configuration. Your AI now remembers, learns, and evolves.

**Say "help" or "帮助" to see all commands.**

---

## Vector Search — Understand Meaning, Not Just Keywords

cc-soul has two search modes. **Keyword mode works out of the box** — no setup needed. **Vector mode** adds semantic understanding for dramatically better recall.

### The Difference

| You ask | Keyword mode (default) | Vector mode |
|---------|----------------------|-------------|
| "that deployment thing" | Only finds memories containing the word "deployment" | Finds "set up server on AWS, SSH port 22" — understands deployment ≈ server setup |
| "the bug from last week" | Matches memories with "bug" in text | Also finds "TypeError crash in auth module" — understands bug ≈ error ≈ crash |
| "what did I say about speed" | Exact word match: "speed" | Also matches "latency is 200ms", "optimize the query" — understands speed ≈ performance ≈ latency |
| "database stuff" | Finds memories containing "database" | Also finds "PostgreSQL connection pool", "Redis cache TTL", "migration script" |

**Keyword mode** uses TF-IDF + trigram matching. Works great for under 10,000 memories or when you remember the exact words.

**Vector mode** uses a local AI model to understand meaning. Recommended for 10,000+ memories or when you want "I know I talked about this but can't remember the exact words" recall.

### How to Enable (2 minutes)

Download the embedding model (~90MB) — runs 100% locally, no API calls:

```bash
mkdir -p ~/.openclaw/plugins/cc-soul/data/models/minilm
cd ~/.openclaw/plugins/cc-soul/data/models/minilm
curl -L -o model.onnx "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx"
curl -L -o vocab.json "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"
```

Restart gateway. Done.

### Resource Usage

| | Size | RAM | CPU |
|---|---|---|---|
| **Model files** | ~90MB on disk | ~120MB when loaded | One-time load at startup |
| **Per query** | — | Negligible | ~5ms per embedding (CPU only, no GPU needed) |
| **Memory vectors** | ~1.5KB per memory | ~7MB for 5,000 memories | Computed once, cached |

The model runs on CPU — no GPU required. It loads once at startup and stays in memory. On a typical laptop, you won't notice any performance impact.

### Without Vector (Fallback)

If you don't download the model, cc-soul works exactly the same — just with keyword matching instead of semantic matching. Nothing breaks. No errors. You can add vector search later at any time.

```
[Logs without vector — totally normal]
[cc-soul][memory] loaded 5053 memories from JSON
[cc-soul] initialized: 5053 mem, 31 rules

[Logs with vector — auto-detected]
[cc-soul][embedder] ready — all-MiniLM-L6-v2 (384d, CPU)
[cc-soul][memory] embedder ready — vector search enabled
```

---

## What Changes

| | Before | After |
|---|---|---|
| **Memory** | Forgets everything | Remembers 10,000+ facts permanently |
| **Personality** | Same robotic tone | 11 natural styles that blend by context |
| **Emotions** | Ignores your mood | 5-dimension emotion model, adjusts in real time |
| **Learning** | Repeats the same mistakes | Learns from every correction, verifies before accepting |
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

## Feature Examples

### Memory — It Remembers Everything

```
You:  "I deployed the backend on AWS us-east-1, port 8080, Python 3.11"
AI:   Stored.

[3 weeks later]

You:  "What server did I set up?"
AI:   "AWS us-east-1, port 8080, Python 3.11 — deployed about 3 weeks ago."

You:  "search memory deploy"
AI:   Shows all memories matching "deploy" with confidence scores.

You:  "pin memory AWS"
AI:   Pinned — this memory will never decay or be evicted.

You:  "export memories"
AI:   Exports 5,000+ memories to JSON. Compatible with Mem0/ChatGPT formats.
```

### Personality — 11 Personas That Auto-Switch

```
You:  "This code keeps segfaulting"
AI:   [engineer mode] Analyzes the crash, suggests fixes with code snippets.

You:  "I'm stressed about the deadline"
AI:   [comforter mode] Acknowledges your feelings, offers practical help.

You:  "Should I use Redis or Memcached?"
AI:   [analyst mode] Compares both with pros/cons table.

You:  "Teach me how Docker networking works"
AI:   [teacher mode] Step-by-step explanation with examples.

You:  "帮我理解 what is a closure?"
AI:   [socratic mode] Doesn't give the answer. Instead:
      "When a function returns another function, what happens
       to the variables in the outer scope? Try this:
       function outer() { let x = 1; return () => x; }
       What do you think outer()() returns, and why?"
      Guides you to understand it yourself, one question at a time.

You:  "I think recursion just calls itself"
AI:   [socratic mode] "That's the surface — but what actually
       happens in memory each time? If f(3) calls f(2) calls f(1),
       where does f(3) 'wait'? What structure holds that?"
      Pushes you from memorization to real understanding.
```

**Trigger words for Socratic mode:** `帮我理解`, `引导我`, `教我`, `别告诉我答案`, `提示一下`, `guide me`, `help me understand`

### Learning — Gets Smarter Over Time

```
You:  "No, Python's default encoding is UTF-8, not ASCII"
AI:   Checks its knowledge. Confirms you're right.
      Creates rule: "Python 3 default encoding = UTF-8"
      This rule is tested over 3 conversations before becoming permanent.

You:  "You keep formatting dates wrong, use YYYY-MM-DD"
AI:   Learns the pattern. After 3 verified corrections:
      Rule locked: "Always use ISO 8601 date format for this user"
```

### Emotions — Reads the Room

```
You:  [frustrated] "This is the third time it broke!!"
AI:   Detects frustration. Responds concisely — no fluff, just solutions.
      Internally: arousal↑, pleasure↓, dominance↓

You:  "Thanks, that actually fixed it!"
AI:   Detects positive feedback. Energy↑, mood↑.
      Might proactively mention: "By the way, I noticed a similar
      pattern in your auth module — want me to check?"
```

### Knowledge Graph — Connects the Dots

```
You:  "knowledge map"
AI:   Generates a Mermaid diagram showing entities and their relationships:
      [Python] --uses--> [FastAPI] --deploys-on--> [AWS]
      [Redis] --caches-for--> [FastAPI]

You:  "What do I know about my backend stack?"
AI:   Walks the graph: "You use FastAPI on Python 3.11, deployed on AWS
      us-east-1, with Redis for caching and PostgreSQL for persistence."
```

### Daily Life — Habits, Goals, Reminders

```
You:  "checkin exercise"
AI:   "Exercise: Day 12 streak!"

You:  "new goal Launch MVP by April"
AI:   "Goal created. I'll track your progress."

You:  "remind 09:00 standup meeting"
AI:   "Reminder set: every day at 9:00 — standup meeting."

You:  "my goals"
AI:   Shows all goals with progress bars and milestones.
```

### Privacy — You're in Control

```
You:  "privacy mode"
AI:   "Privacy mode ON. Nothing from this conversation will be stored."

You:  "privacy mode off"
AI:   "Privacy mode OFF. Resuming normal operation."

You:  "delete memory password"
AI:   Finds and removes all memories matching "password".

You:  "audit log"
AI:   Shows SHA256 chain-linked log of all memory operations.
```

### RAG — Feed It Any Document

```
You:  "ingest ~/docs/api-spec.md"
AI:   "Ingested 47 chunks from api-spec.md into memory."

You:  "What's the rate limit on the /users endpoint?"
AI:   Recalls from ingested doc: "100 requests/min per API key,
      with burst allowance up to 150. See section 3.2."

You:  "ingest ~/papers/attention-is-all-you-need.pdf"
AI:   Detects academic paper format. Extracts key concepts,
      methodology, and conclusions as structured memories.

You:  "How does multi-head attention work?"
AI:   Answers from ingested paper memory — not hallucinating,
      citing what it actually read.
```

Supports: Markdown, source code, academic papers, plain text. Auto-detects format.

### Proactive Expansion — It Thinks Ahead

```
You:  "Fix this connection timeout error"
AI:   Fixes the error. Then:
      "I noticed 3 related issues you should know about:
       1. Your connection pool is 5 but you run 20 workers — bottleneck
       2. No retry logic on transient failures
       3. The timeout is 3s but your DB query p99 is 2.8s"

You:  "Set up a new FastAPI project"
AI:   Creates the project. Then:
      "Based on your previous projects, you'll probably need:
       - CORS middleware (you always add it later)
       - Your standard logging config
       - PostgreSQL with async driver (your usual stack)"
```

It doesn't just answer — it anticipates what you'll need next.

### Contradiction Detection — Self-Correcting Memory

```
[Memory contains: "User prefers PostgreSQL"]

You:  "I've switched to MySQL for this project"
AI:   Detects contradiction with existing memory.
      Updates: "User generally prefers PostgreSQL,
      but uses MySQL for current project (2024-03)"

You:  "memory health"
AI:   "5,231 memories | 3 contradictions found | 12 near-duplicates
       Confidence: 94.2% | Decay: 47 compressed this week"
```

### Dream Mode — Discovers Hidden Connections

```
[During idle time, cc-soul "dreams" — replaying and connecting memories]

AI:   "Dream insight: You mentioned 'Redis cache invalidation issues'
       last week and 'stale data in dashboard' yesterday. These might
       be the same root cause — your cache TTL is 1 hour but the
       dashboard refreshes every 30 minutes."
```

### Lorebook — Persistent Knowledge Base

```
You:  "export lorebook"
AI:   Exports sanitized knowledge base (no PII, ClawHub compatible).

[Lorebook entries auto-inject into conversations when relevant]

You:  "How should I handle auth?"
AI:   [Lorebook auto-injects your team's auth standards]
      "Based on your project conventions: JWT with RS256,
       refresh tokens in httpOnly cookies, 15-min access token TTL."
```

### Quality Scoring — Learns What Works For You

```
[cc-soul scores every response and learns from your reactions]

Short, direct answer → you follow up positively → score ↑
Long explanation → you say "too long" → score ↓

Over time, it learns: "This user prefers concise code-first
responses. Avoid long preambles. Show the fix, then explain."
```

### Stats Dashboard — See Everything

```
You:  "stats"
AI:   ┌─────────────────────────────────┐
      │ Messages: 1,247  Memories: 5,053│
      │ Quality: 7.8/10  Recall: 94.2%  │
      │ Mood: calm  Energy: 82%         │
      │ Active persona: engineer (67%)   │
      │ Rules learned: 31               │
      │ Streak: 23 days                 │
      └─────────────────────────────────┘

You:  "mood report"
AI:   Shows 7-day emotional arc with trend analysis.

You:  "capability score"
AI:   Shows confidence scores per domain:
      Python 92% | DevOps 78% | Frontend 45% | ...
```

---

## 180+ Features in 22 Categories

### Memory Engine (20)
Semantic tag recall · BM25 + trigram fuzzy search · graph-enhanced query expansion · auto-merge duplicates · daily contradiction scan · predictive recall · associative recall · session summaries · 3-tier time decay (HOT/WARM/COLD) · entity time-series with auto-expiry · CRUD decision engine (dedup at 0.7) · core memory pinning · working memory isolation · active memory management · archival reactivation · multi-route scoring (tag×1.0 + trigram×0.5 + BM25×0.7) · OpenClaw hybrid recall (FTS5) · Chain-of-Thought memory (stores reasoning process) · **smart forget (Weibull survival + ACT-R activation)** · **context compression (ACON progressive summarization)**

### Memory Commands (8)
Pin/unpin memory · search memory · delete memory · export memories (JSON) · import memories (auto-dedup, supports cc-soul/Mem0/ChatGPT/Character Card formats) · memory health audit · auto-cleanup · semantic versioning (keeps history on update)

### Knowledge Graph (6)
Entity extraction + relation modeling · persistent graph database · temporal relations (validFrom/validUntil) · BFS graph walk recall · entity summary generation · path queries between entities

### Cognitive Pipeline (11)
3-stage attention gate · intent prediction · strategy selection · atmosphere sensing · frustration detection · implicit feedback recognition · adaptive reasoning depth (auto-adjusts by complexity) · Graph-of-Thoughts multi-path reasoning · **internal debate (multi-persona deliberation for complex questions)** · **theory of mind (tracks user beliefs/knowledge/goals/frustrations)** · **context compression (ACON progressive summarization saves 50-80% tokens)**

### Personality System (9)
11 auto-switching personas (engineer, friend, mentor, analyst, comforter, strategist, explorer, executor, teacher, devil's advocate, socratic) · smooth persona blending · per-user style preference learning · **Shannon entropy persona drift detection** · drift auto-correction · bidirectional emotional contagion · relationship dynamics · persona usage tracking with growth curve · Socratic mode triggers (帮我理解/引导我/教我/别告诉我答案)

### Body Simulation (8)
Energy management · mood model · PADCN 5-dimension emotion vector (Pleasure/Arousal/Dominance/Certainty/Novelty) · circadian rhythm adjustment · 7-day emotional arc · weekly mood report · cognitive load tracking · trend detection

### Conversation Flow (7)
Multi-turn topic tracking · topic persistence · session end detection · privacy mode · emergency mode · proactive expansion across 22 tech + 11 life domains · reverse prompting (asks clarifying questions for ambiguous messages)

### Learning & Evolution (9)
Auto-discover rules from corrections · Bayesian hypothesis verification (Beta posterior + Wilson CI) · 5-class root cause attribution · strategy chain replay · reflection rule tracking · meta-learning insights · rule compression (auto-merge similar rules) · Chain-of-Thought memory · five-stage self-reflection loop (plan→execute→verify→solidify)

### Correction System (2)
Auto-verify corrections (checks facts before accepting or rejecting) · correction-triggered verification

### Inner Life (6)
Journal writing · deep reflection · dream mode · follow-up plan tracking · self-challenge on weak domains · regret tracking

### Autonomous Behavior (7)
Impulse-driven proactive messages · autonomous goal decomposition + execution · auto-create reusable skills · skill library lookup · **cron agent (scheduled autonomous tasks: daily/weekly/interval)** · **skill extraction (n-gram pattern detection → reusable automations)** · **smart forget (Weibull+ACT-R intelligent memory decay)**

### Quality System (5)
Logistic regression response scoring · AdaGrad adaptive weight learning · hard example replay · dual self-check · **LLM self-judge (1-10 scoring with trend tracking)**

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

### Parameter Tuning (5)
Thompson Sampling with 5-arm discretization · real-time reward tracking · A/B experiment framework · phased evolution · context-aware augment budget

### Diagnostics & Monitoring (5)
7-dimension health scan · code quality audit · module health monitoring · timeout protection · metrics command (messages, response time, recall calls)

### Security (4)
Prompt injection detection (9 regex patterns) · immutable audit log (sha256 chain) · PII filtering (email/phone/API key/IP/social accounts) · MCP rate limiting

### User Features (12)
Habit tracking + streaks · goal tracking + milestones · scheduled reminders (via heartbeat) · conversation summary · capability score display · weekly mood report · memory graph HTML visualization · export/import soul config · export Lorebook (sanitized, ClawHub compatible) · voice output (macOS say) · multi-agent orchestration prompts · new user onboarding

### Agent Interop (3)
**A2A Protocol (Agent-to-Agent)** — exposes 5 capabilities (memory-recall, persona-switch, emotion-tracking, knowledge-graph, quality-eval) as standard Agent Card · MCP tool provider (4 tools for cross-agent queries) · multi-agent orchestration prompts

### Infrastructure (5)
Multi-backend AI adapter (Claude/OpenAI/Ollama/Groq/OpenRouter/Zhipu/Tongyi/Kimi) · zero-dependency SQLite + vector search with graceful fallback · full language auto-follow · SoulSpec compatibility (soul.json + STYLE.md + IDENTITY.md + HEARTBEAT.md) · brain module registry with circuit breaker fault isolation

---

## Commands

| Command | What it does |
|---------|-------------|
| `help` / `帮助` | **Full command guide — start here** |
| `stats` | Personal dashboard — messages, memories, quality, mood, persona growth |
| `soul state` | AI energy, mood, alertness, PADCN emotion vector |
| `features` | List all feature toggles |
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
| `delete reminder <N>` | Delete a reminder by number |
| `memory timeline <keyword>` | View change history for a topic |
| `cost` / `成本` | Token usage statistics |
| `dashboard` / `仪表盘` | Open web dashboard (HTML) |
| `audit log` | View immutable audit trail |
| `read aloud <text>` | Voice output (macOS) |

---

## How Features Work — Automatic vs Manual

**Say "help" or "帮助" anytime to see all commands.**

### Runs automatically (no action needed)
| Feature | What happens |
|---------|-------------|
| Memory recording | Every conversation is analyzed and stored |
| Persona switching | 11 personas auto-select based on your message content |
| Emotion tracking | Detects your mood and adjusts response style |
| Learning from corrections | When you say "that's wrong", AI learns and remembers |
| Proactive expansion | Adds related insights you didn't ask for |
| Contradiction detection | Flags conflicts between memories |
| Memory decay | Old unused memories gradually fade |
| Smart forget | Weibull+ACT-R model decides what to forget |
| Context compression | Long conversations auto-compress to save tokens |
| Theory of mind | Tracks your knowledge gaps and adapts explanations |
| Persona drift detection | Auto-corrects if personality style drifts |
| A2A protocol | Other AI agents can query your soul's memory and knowledge |

### Triggered by keywords (just say it)
| Say this | What happens |
|----------|-------------|
| "帮我理解" / "引导我" / "别告诉我答案" | Socratic mode — guides you with questions instead of answers |
| "隐私模式" / "别记了" | Pauses all memory storage |
| "可以了" / "恢复记忆" | Resumes memory storage |
| "上次聊..." / "接着聊..." | Recalls related topic from memory |

### Opt-in features (off by default, enable with `enable X`)
| Feature | Toggle name | Why off by default |
|---------|------------|-------------------|
| Internal debate | `debate` | Uses extra tokens for multi-perspective deliberation |
| LLM self-judge | `llm_judge` | Requires extra API calls to self-evaluate |
| Dream mode | `dream_mode` | Background activity during idle time |

---

## What Makes cc-soul Different

Features no other AI memory plugin has:

| Feature | What it does |
|---------|-------------|
| **A2A Protocol** ⭐ | Agent-to-Agent — other AI agents can query cc-soul's memory, persona, and knowledge graph via standard protocol |
| **Theory of Mind** ⭐ | Tracks what you know, believe, and struggle with — detects repeated misconceptions and adapts explanations |
| **Internal Debate** ⭐ | Complex questions trigger multi-perspective debate between personas before answering — you get the synthesized best answer |
| **Smart Forget** | Weibull survival model + ACT-R activation — intelligently forgets low-value memories instead of hoarding everything |
| **Context Compression** | ACON-based progressive compression — old context auto-summarizes to save tokens while keeping key facts |
| **Cron Agent** | Schedule autonomous tasks: "every day 09:00 check my goals" — runs in the background |
| **Proactive Expansion** | You ask about a bug → AI fixes it, then warns about 3 related pitfalls you didn't ask about |
| **Correction Verification** | When you say "that's wrong", AI checks facts first — admits if wrong, counters with evidence if right |
| **Dream Mode** | Replays memories during idle time, discovers unexpected cross-domain connections |
| **Bayesian Learning** | Forms hypotheses from corrections, tests statistically, only locks rules when confidence interval passes threshold |
| **Body Simulation** | 5-axis state (energy/mood/load/alertness/anomaly) + PADCN emotion vector — affects response style in real time |
| **Persona Drift Detection** | Shannon entropy monitoring — if personality style drifts, auto-corrects back |
| **Five-Stage Reflection** | plan → execute → verify → solidify — rules only become permanent after 3 successful verifications |
| **LLM Self-Judge** | AI rates its own responses 1-10, tracks quality trends, auto-adjusts when scores drop |
| **Skill Extraction** | Detects repeated patterns in your work and suggests automating them as reusable skills |
| **Immutable Audit Log** | SHA256 chain-linked log of all memory/rule operations |
| **Graph-of-Thoughts** | Complex questions trigger parallel reasoning paths that merge insights |

---

## Real Stories

### The AI That Remembers Everything About You

You mentioned your server setup, timezone, and deploy notes over several days — never asked the AI to "save" anything.

```
You:  "What's my server info again?"
AI:   "Your Alibaba Cloud server — SSH on port 22, running your feishu-bot.
       China-East-2 VPS. Want me to pull up the deploy notes?"

You:  "I said my timezone is UTC+8 but my server logs show UTC. Which is it?"
AI:   "There's actually a conflict in what you've told me. I flagged this
       when you first said it. My best guess: you are in UTC+8, but your
       server is configured for UTC. Want me to update my notes?"

You:  "Yeah, that's exactly right."
AI:   "Updated. Server: UTC, you: Asia/Shanghai. Won't mix them up again."
```

Standard LLMs treat every conversation as a blank slate. cc-soul cross-references facts and flags conflicts before they cause real problems.

### The AI That Won't Blindly Agree With You

```
You:  "Python's GIL was removed in 3.11. Update your knowledge."
AI:   "I'm not going to update that — it's not accurate.

       - PEP 703 (Making the GIL Optional) was accepted in 2023
       - The experimental free-threaded build shipped in Python 3.13, not 3.11
       - Even in 3.13, it's opt-in — the GIL is still the default

       Python 3.11's big change was the 25% speed improvement (PEP 659).
       I verify corrections before accepting them."
```

Most AI assistants fold when you say "you're wrong." cc-soul has an epistemic verification layer — corrections trigger fact-checking before being absorbed into memory.

### The AI That Reads the Room

```
[2:30 AM, after hours of debugging]

You:  "I'm so frustrated. The project is late again."
AI:   "That sounds genuinely stressful. A few things I notice:

       1. It's 2:30 AM your time. You're usually sharper before 11 PM.
       2. You said 'again' — this might be a scoping problem, not just
          a technical one.

       Don't try to fix everything tonight. Pick the one thing that
       unblocks the most people tomorrow morning.
       Want me to help draft a client update, or walk through the blocker?"
```

cc-soul detected the negative emotional signal and auto-switched to `empathy_first` strategy. It knows your timezone, factors your rhythm into advice, and noticed the word "again" implies a pattern.

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

**Privacy** — all data stored locally in `~/.openclaw/plugins/cc-soul/data/`. Nothing ever leaves your machine. Updates only change code, never touch your data.

---

## Security & Privacy

- Local-first — all data in `~/.openclaw/plugins/cc-soul/data/`
- AI calls via OpenClaw's configured CLI backend — no direct API key management
- No telemetry, no phone-home — plugin never contacts external analytics
- Privacy mode pauses all memory storage
- PII auto-filtering (email/phone/API key/IP)
- Prompt injection detection (9 patterns)
- Immutable audit log (SHA256 chain)
- MCP tools rate-limited
- [SECURITY.md](https://github.com/wenroudeyu-collab/cc-soul/blob/main/SECURITY.md)

---

## Feedback

- **Issues & Feature Requests**: [github.com/wenroudeyu-collab/cc-soul/issues](https://github.com/wenroudeyu-collab/cc-soul/issues)
- **Email**: wenroudeyu@gmail.com

---

[npm](https://www.npmjs.com/package/@cc-soul/openclaw) · [GitHub](https://github.com/wenroudeyu-collab/cc-soul)

*Not a chatbot. A companion that remembers, reflects, and grows.*
