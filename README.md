# cc-soul

> Zero-vector AI memory engine that learns from every conversation.
> LOCOMO benchmark: **4th place (76.2%)** — the only symbolic system in the top 5.

```bash
npm install @cc-soul/openclaw
```

100% local memory. Zero cloud upload. Zero telemetry. Zero vectors. Zero embeddings. Zero GPU. **Open source (MIT).**

---

## Why cc-soul?

| | cc-soul | ChatGPT Memory | Google Gemini |
|---|---------|---------------|---------------|
| **Data location** | Your device (SQLite) | OpenAI cloud | Google cloud |
| **Upload** | Never | Always | Always |
| **GDPR compliance** | By design | Fined €15M (Italy) | Requires opt-in (EU) |
| **Works offline** | Yes | No | No |
| **Memory engine** | 17 original algorithms (cognitive science) | Vector search | Vector search |
| **Recall latency** | <30ms (local) | Network-dependent | Network-dependent |
| **Vendor lock-in** | None — works with any AI | OpenAI only | Google only |
| **User data training** | Impossible (no server) | Opt-out required | Opt-out required |

---

## How It Works — No Vectors, No Embeddings, No Cloud

cc-soul doesn't use vector databases or embedding models. Instead, it's built on **cognitive science** — memories aren't "searched", they surface automatically, like the human brain.

**Three core innovations:**

**1. Neural Activation Memory (NAM)** — Each memory has a real-time activation score [0, 1], computed from 7 signals: recency, context match, emotional resonance, spreading activation, interference suppression, temporal encoding, and sequential co-occurrence. Based on ACT-R cognitive architecture.

**2. Three-Layer Distillation** — Raw memories (L1) cluster into topic nodes (L2), which distill into a mental model of you (L3). Like how the human brain consolidates short-term memory into long-term understanding during sleep.

**3. Zero-LLM Recall** — Memory retrieval needs no AI model. Five parallel channels (tags, trigrams, BM25, vector FTS, knowledge graph) fuse results in <30ms. The AI only sees what's relevant.

---

## Quick Start

```bash
npm install -g @cc-soul/openclaw
# Done. API auto-starts at localhost:18800. Two endpoints, ready to use.
```

---

## API — Just Two Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/memories` | Store a memory |
| `POST` | `/search` | Search memories |
| `GET` | `/health` | Health check |

That's it. Store and retrieve. Everything else (learning, distillation, decay, dedup) happens automatically in the background.

### POST /memories — Store

```bash
curl -X POST http://localhost:18800/memories \
  -H "Content-Type: application/json" \
  -d '{"content": "I deployed on AWS us-east-1, port 8080, Python 3.11", "user_id": "alice"}'
```

Response:
```json
{"stored": true, "facts_extracted": 3}
```

Facts are automatically extracted and indexed. AAM learns word associations. No extra calls needed.

### POST /search — Retrieve

```bash
curl -X POST http://localhost:18800/search \
  -H "Content-Type: application/json" \
  -d '{"query": "server config", "user_id": "alice"}'
```

Response:
```json
{
  "memories": [
    {"content": "I deployed on AWS us-east-1, port 8080, Python 3.11", "scope": "fact", "ts": 1712534400, "confidence": 0.85}
  ],
  "facts": [
    {"predicate": "deployed_on", "object": "AWS us-east-1", "confidence": 0.9}
  ],
  "fact_summary": "Deployed on AWS us-east-1 with Python 3.11",
  "_meta": {"reranked": false, "query_rewritten": false}
}
```

Parameters:
- `query` — what to search for (required)
- `user_id` — user identifier (default: "default")
- `top_n` / `limit` — number of results (default: 5)

### GET /health

```bash
curl http://localhost:18800/health
# → {"status": "ok", "version": "2.9.2", "memoryCount": 5231, "factCount": 892, "llm": {"configured": true}}
```

---

## LLM Configuration (Optional)

cc-soul works **without any LLM** — NAM recall runs purely on local algorithms (<30ms). If you add an LLM, you get two bonus features:

- **Query Rewrite** — abstract queries ("What are my habits?") get expanded with specific keywords before search
- **LLM Rerank** — NAM recalls 4x candidates, LLM picks the most relevant ones

### Setup

After install, cc-soul auto-creates a config template at `~/.cc-soul/data/ai_config.json`. Just fill in three fields:

```json
{
  "backend": "openai-compatible",
  "api_base": "https://api.deepseek.com/v1",
  "api_key": "sk-xxx",
  "api_model": "deepseek-chat"
}
```

Any OpenAI-compatible API works:

| Provider | api_base | api_model |
|----------|----------|-----------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Claude | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5:7b` |

**OpenClaw users**: just talk to your AI:

```
You: "帮我查看下 ~/.cc-soul/data/ai_config.json 并且告诉我怎么配置"
AI:  (reads the file, shows current config, guides you step by step)

You: "我要用 DeepSeek，key 是 sk-xxx"
AI:  (writes the config for you, done)
```

No manual editing needed — your AI is your setup assistant.

Config is hot-reloaded — save the file and cc-soul picks it up automatically, no restart needed.

---

## How to Integrate

### Python

```python
import requests

API = "http://localhost:18800"

# Store memories from conversations
requests.post(f"{API}/memories", json={
    "content": "User prefers Python over Java, deployed on AWS",
    "user_id": "alice"
})

# Later: retrieve relevant memories
results = requests.post(f"{API}/search", json={
    "query": "what language does alice prefer?",
    "user_id": "alice"
}).json()

# Feed memories to your AI
from openai import OpenAI
client = OpenAI()
memory_context = "\n".join([m["content"] for m in results["memories"]])
reply = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": f"User context:\n{memory_context}"},
        {"role": "user", "content": "What language should I use for this project?"}
    ]
).choices[0].message.content
```

### JavaScript / Node.js

```javascript
const API = "http://localhost:18800"

// Store
await fetch(`${API}/memories`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Likes spicy food, lives in Berlin", user_id: "bob" })
})

// Search
const res = await fetch(`${API}/search`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: "food preferences", user_id: "bob" })
})
const { memories, facts } = await res.json()
```

### cURL

```bash
# Store
curl -X POST http://localhost:18800/memories \
  -H "Content-Type: application/json" \
  -d '{"content": "Meeting with John next Tuesday at 3pm", "user_id": "alice"}'

# Search
curl -X POST http://localhost:18800/search \
  -H "Content-Type: application/json" \
  -d '{"query": "upcoming meetings", "user_id": "alice"}'

# Health
curl http://localhost:18800/health
```

### OpenClaw Users

```bash
openclaw plugins install @cc-soul/openclaw
# Done. Works automatically in the background. Say "help" to see commands.
```

---

## What Happens Automatically

You only call two endpoints. Behind the scenes, cc-soul runs a full cognitive pipeline:

```
POST /memories → store → dedup → fact extraction → AAM association learning
                                                          ↓
                          ┌─────────── background ───────────────┐
                          │ every minute:  memory decay           │
                          │ every hour:    FSRS consolidation     │
                          │ every 6h:     L1→L2 topic clustering  │
                          │ every 12h:    L2→L3 mental model      │
                          │ every 24h:    full L3 refresh         │
                          └──────────────────────────────────────┘
                                                          ↓
POST /search  → NAM 7-signal activation → MMR dedup → coverage rerank
                (+ LLM rewrite & rerank if configured)
```

---

## Core Scenarios

### 1. Proactive Expansion + Association Chain

```
You:  "Fix this connection timeout error"
AI:   Fixes the error. Then:
      "I noticed 3 related issues:
       1. Your connection pool is 5 but you run 20 workers — bottleneck
       2. No retry logic on transient failures
       3. The timeout is 3s but your DB query p99 is 2.8s"
```

cc-soul doesn't just answer — it recalls your past context and anticipates what you'll need next. It expands across 22 tech domains and 11 life domains.

### 2. Socratic Teaching

```
You:  "帮我理解 what is a closure?"
AI:   Doesn't give the answer. Instead:
      "When a function returns another function, what happens
       to the variables in the outer scope? Try this:
       function outer() { let x = 1; return () => x; }
       What do you think outer()() returns, and why?"
```

Trigger words: `帮我理解`, `引导我`, `教我`, `别告诉我答案`, `guide me`, `help me understand`

### 3. Correction Verification

```
You:  "Python's GIL was removed in 3.11. Update your knowledge."
AI:   "I'm not going to update that — it's not accurate.
       PEP 703 shipped in Python 3.13, not 3.11. Even in 3.13,
       the GIL is still the default. I verify corrections
       before accepting them."
```

When you say "that's wrong", cc-soul checks facts first. If you're right, it learns. If you're wrong, it counters with evidence. Rules are verified over 3 conversations before becoming permanent (Bayesian hypothesis testing).

### 4. Persistent Memory

```
You:  "I deployed the backend on AWS us-east-1, port 8080, Python 3.11"
AI:   Stored.

[3 weeks later]

You:  "What server did I set up?"
AI:   "AWS us-east-1, port 8080, Python 3.11 — about 3 weeks ago."
```

10,000+ memories with auto-dedup, contradiction detection, 3-tier time decay (HOT/WARM/COLD), and smart forget (Weibull survival + ACT-R activation).

### 5. Emotion + 11 Personas

```
You:  "This code keeps segfaulting"
AI:   [engineer mode] Analyzes the crash, suggests fixes.

You:  "I'm stressed about the deadline"
AI:   [comforter mode] Acknowledges feelings, offers practical help.

You:  "Should I use Redis or Memcached?"
AI:   [analyst mode] Compares both with pros/cons.
```

5-dimension emotion model (Pleasure/Arousal/Dominance/Certainty/Novelty). 11 personas auto-switch by context: engineer, friend, mentor, analyst, comforter, strategist, explorer, executor, teacher, devil's advocate, socratic.

### 6. Life Assistant

```
You:  "打卡 exercise"          → "Exercise: Day 12 streak!"
You:  "新目标 Launch MVP by April" → Goal created with progress tracking.
You:  "提醒 09:00 standup"      → Daily reminder set.
You:  "晨报"                   → Morning briefing with goals, reminders, mood.
You:  "周报"                   → Weekly review with trends and insights.
```

---

## What's Running Behind the Scenes (43 always-on features)

All automatic. No setup, no toggles. Works from the first message.

**Memory (NAM Engine)**
- Every message auto-extracted for facts, preferences, events
- NAM 7-signal activation field — memories surface by relevance, not keyword match
- Contradiction detection — catches when you contradict yourself
- Smart decay (Weibull + ACT-R) — unused memories fade, important ones strengthen
- Memory compression — 90-day+ memories distilled into summaries
- WAL protocol — key facts persisted before AI replies (crash-safe)
- DAG archive — lossless archival replaces hard deletion
- Associative recall — one memory activates related ones
- Predictive recall — pre-warms memories based on conversation patterns

**Understanding**
- 7-dimension deep understanding — temporal patterns, growth trajectory, cognitive load, stress fingerprint, say-do gap, unspoken needs, dynamic profile
- Theory of mind — tracks your beliefs, knowledge gaps, frustrations
- Decision causal recording — stores WHY you chose, not just what
- Value conflict learning — tracks which values you prioritize in tradeoffs
- Social context adaptation — adjusts tone when you mention boss vs friend
- Person model — identity, thinking style, communication decoder ("算了" → "换个角度")
- Expression fingerprint — learns your argument style and certainty level

**Personality & Emotion**
- 11 personas auto-blend by context — like a friend who adjusts their tone naturally
- Emotion tracking — senses your mood from messages, adapts in real time
- Your mood affects AI's mood — just like talking to a real person
- Late night = concise replies, Monday morning = gentle start

**Proactive Intelligence**
- Proactive expansion — adds related pitfalls after answering
- Absence detection — notices topics you stopped mentioning
- Behavior prediction — warns when you're about to repeat a past mistake
- Proactive questioning — asks about knowledge gaps it detects
- Follow-up tracking — "I'll do it tomorrow" → next day reminder
- Soul moments — naturally references shared history at milestones

**Infrastructure**
- Knowledge graph — entities and relationships auto-extracted
- Context compression — long conversations auto-compressed to save tokens
- Quality scoring — learns which response style works for you
- LLM batch queue — non-urgent tasks queued for off-hours
- Habit/goal/reminder tracking
- Cost tracking — token usage per conversation

**6 optional features** (user can toggle): `auto_daily_review` · `self_correction` · `memory_session_summary` · `absence_detection` · `behavior_prediction` · `auto_mood_care`

---

## Privacy & Security

All data stored locally (`~/.cc-soul/data/` or `~/.openclaw/plugins/cc-soul/data/` if using OpenClaw). Auto-detected, auto-created. Nothing ever leaves your machine. No telemetry.

- **Privacy mode** — say `隐私模式` to pause all memory storage
- **PII filtering** — auto-strips emails, phone numbers, API keys, IPs
- **Prompt injection detection** — 9 pattern filters
- **Immutable audit log** — SHA256 chain-linked operation history
- **MCP rate limiting** — prevents abuse from external agents
- **Full data export** — `导出全部` exports everything to a single JSON you own

See SECURITY.md for full details.

---

## Quick Commands

| Command | What it does |
|---------|-------------|
| `help` / `帮助` | Full command guide |
| `stats` | Dashboard — messages, memories, quality, mood |
| `soul state` | AI energy, mood, emotion vector |
| `我的记忆` / `my memories` | View recent memories |
| `搜索记忆 <词>` / `search memory <kw>` | Search memories |
| `删除记忆 <词>` / `delete memory <kw>` | Remove matching memories |
| `pin 记忆 <词>` / `pin memory <kw>` | Pin memory (never decays) |
| `隐私模式` / `privacy mode` | Pause all memory storage |
| `打卡 <习惯>` / `checkin <habit>` | Track a habit |
| `新目标 <描述>` / `new goal <desc>` | Create a goal |
| `提醒 HH:MM <消息>` / `remind HH:MM <msg>` | Daily reminder |
| `情绪周报` / `mood report` | 7-day emotional trend |
| `能力评分` / `capability score` | Domain confidence scores |
| `摄入文档 <路径>` / `ingest <path>` | Import document to memory |
| `知识图谱` / `knowledge map` | Visualize knowledge graph |
| `features` / `功能状态` | View feature toggles |
| `开启 <X>` / `关闭 <X>` | Enable/disable feature |
| `dashboard` / `仪表盘` | Open web dashboard |
| `cost` / `成本` | Token usage statistics |
| `audit log` / `审计日志` | View audit trail |
| `导出全部` / `export all` | Full backup: memories + persona + values + rules to one JSON |
| `导入全部 <路径>` / `import all <path>` | Restore from full backup |
| `别记这个` / `don't remember` | Skip storing next message to memory |
| `人格列表` / `personas` | List all 11 personas |
| `价值观` / `values` | Show value priorities |

---

## All Commands

**Memory:** `我的记忆` · `搜索记忆 <词>` · `删除记忆 <词>` · `pin 记忆 <词>` · `unpin 记忆 <词>` · `记忆时间线 <词>` · `记忆健康` · `记忆审计` · `恢复记忆 <词>` · `记忆链路 <词>` · `共享记忆 <词>` · `私有记忆 <词>`

**Import/Export:** `导出全部` · `导入全部 <路径>` · `导出lorebook` · `导出进化` · `导入进化 <路径>` · `摄入文档 <路径>`

**Daily Life:** `打卡 <习惯>` · `习惯状态` · `新目标 <描述>` · `目标进度 <目标> <更新>` · `我的目标` · `提醒 HH:MM <消息>` · `我的提醒` · `删除提醒 <序号>`

**Status:** `stats` · `soul state` · `晨报` · `周报` · `情绪周报` · `能力评分` · `成长轨迹` · `我的技能` · `metrics` · `cost` · `dashboard` · `记忆图谱 html` · `对话摘要`

**Insights:** `时间旅行 <词>` · `推理链` · `情绪锚点` · `记忆链路 <词>`

**Experience:** `讲讲我们的故事` · `每日复盘` · `保存话题` · `切换话题 <名称>` · `话题列表`

**Persona & Values:** `人格列表` · `价值观` · `别记这个`

**Advanced:** `功能状态` · `开启 <功能>` · `关闭 <功能>` · `审计日志` · `开始实验 <描述>`

---

---

## Benchmark — LOCOMO Leaderboard

cc-soul is the **only symbolic (non-vector) system** in the top 5.

| Rank | System | Score | Architecture |
|------|--------|-------|-------------|
| 1 | Backboard | 90.0% | Vector + LLM |
| 2 | Hindsight | 89.6% | Vector + LLM |
| 3 | ENGRAM | 77.6% | Vector + LLM |
| **4** | **cc-soul** | **76.2%** | **Symbolic (no vectors)** |
| 5 | Memobase | 75.8% | Vector + LLM |
| 6 | Zep | 75.1% | Vector + LLM |
| 7 | Letta | 74.0% | Vector + LLM |
| 8 | Mem0-Graph | 68.4% | Vector + Graph |
| 9 | Mem0 | 66.9% | Vector + LLM |

### Breakdown by Question Type

| Type | Accuracy |
|------|----------|
| open_domain | 89.4% |
| single_hop | 84.8% |
| multi_hop | 65.7% |
| temporal_reasoning | 62.5% |
| adversarial | 56.5% |
| **TOTAL** | **76.2%** |

### Performance

| Metric | Value |
|--------|-------|
| Recall latency (p50) | 127ms |
| Storage size | 5.7 MB (vs 49.2 MB for vectors — 8.6x smaller) |
| External API calls | 0 (pure algorithm) |
| LLM dependency | Optional (recall works without LLM) |

### Learning Curve (1200 messages)

| Metric | Start | End | Improvement |
|--------|-------|-----|-------------|
| Hit@3 | 30.0% | 67.5% | +37.5% |
| Top-1 | 22.5% | 60.0% | +37.5% |

---

## Technical Specs

| | |
|---|---|
| Modules | 75 |
| Original algorithms | 15 |
| Codebase | 29K+ lines |
| Dependencies | Zero vectors, zero embeddings, zero GPU |
| Storage | SQLite (local) |
| LLM support | DeepSeek / Claude / any OpenAI-compatible API |
| Minimum requirements | Standard CPU, 8GB RAM |

---

**NAM memory engine · 15 original algorithms · 127ms p50 recall · works with or without LLM · 100% local**

[npm](https://www.npmjs.com/package/@cc-soul/openclaw) · [GitHub](https://github.com/wenroudeyu-collab/cc-soul) · wenroudeyu@gmail.com · MIT License

*Your AI remembers everything — and tells no one.*
