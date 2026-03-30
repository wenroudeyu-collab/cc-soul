# cc-soul — Your AI, But It Actually Knows You

Your AI forgets everything after each session. cc-soul fixes that — persistent memory, adaptive personality, emotion tracking, and learning from corrections. Works with any AI.

## Two Ways to Use

### OpenClaw Users (one command, zero config)

```bash
openclaw plugins install @cc-soul/openclaw
# Done. Works automatically. Say "help" to see commands.
```

### Any AI (local API)

```bash
npm install -g @cc-soul/openclaw
cc-soul start
# API running at localhost:18800
```

LLM configuration is **automatic** — cc-soul reads your OpenClaw config if available. Most features (memory, recall, persona, emotion) work without any LLM. Only `/soul` endpoint and background tasks (tagging, reflection) need LLM access.

If not using OpenClaw, set environment variables or POST `/config`:

```bash
# Option 1: environment variables
export LLM_API_BASE=https://api.openai.com/v1
export LLM_API_KEY=sk-xxx
export LLM_MODEL=gpt-4o
cc-soul start

# Option 2: runtime config
curl -X POST localhost:18800/config \
  -d '{"api_base":"https://api.openai.com/v1","api_key":"sk-xxx","model":"gpt-4o"}'
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/process` | **Core.** Send user message, get augmented context (memory + persona + emotion + cognition). No LLM needed. |
| `POST` | `/feedback` | Send AI's reply back. cc-soul learns, stores memories, tracks quality. |
| `POST` | `/soul` | Soul mode — cc-soul replies as the user's avatar (needs LLM). |
| `POST` | `/config` | Configure LLM backend (only needed for `/soul`). |
| `POST` | `/command` | Execute cc-soul commands (stats, search, habits, etc.). |
| `GET` | `/profile` | User personality profile — avatar, social graph, mood, energy. |
| `GET` | `/features` | List all feature toggles and their status. |
| `POST` | `/features` | Enable/disable a feature. |
| `GET` | `/health` | Health check. |
| `GET` | `/.well-known/agent.json` | A2A Agent Card (5 capabilities). |
| `POST` | `/a2a` | Agent-to-Agent protocol request. |
| `GET` | `/mcp/tools` | List MCP tools (4 tools). |
| `POST` | `/mcp/call` | Execute an MCP tool call. |

### POST /process

The core endpoint. Send a user message, get back enriched context to feed your AI.

```bash
curl -X POST http://localhost:18800/process \
  -H "Content-Type: application/json" \
  -d '{"message": "Help me fix this timeout error", "user_id": "alice"}'
```

Response:

```json
{
  "system_prompt": "...(personality + rules + identity)...",
  "augments": "...(recalled memories + proactive insights + persona hints)...",
  "augments_array": [{"content": "...", "priority": 8.2, "tokens": 45}],
  "mood": 0.1,
  "energy": 0.8,
  "emotion": "neutral",
  "cognition": {"attention": "technical", "intent": "wants_answer", "strategy": "balanced", "complexity": 0.6}
}
```

### POST /feedback

After your AI replies, send the exchange back so cc-soul can learn.

```bash
curl -X POST http://localhost:18800/feedback \
  -H "Content-Type: application/json" \
  -d '{"user_message": "Fix this timeout", "ai_reply": "The issue is...", "user_id": "alice", "satisfaction": "positive"}'
```

### POST /command

Execute any cc-soul command via API.

```bash
curl -X POST http://localhost:18800/command \
  -H "Content-Type: application/json" \
  -d '{"message": "search memory deploy", "user_id": "alice"}'
```

### POST /features

```bash
# Enable a feature
curl -X POST http://localhost:18800/features \
  -H "Content-Type: application/json" \
  -d '{"feature": "debate", "enabled": true}'
```

---

## How Other AIs Connect

### Basic Flow (any HTTP client)

```
1. POST /process  { message, user_id }     → get system_prompt + augments
2. Feed system_prompt + augments to your AI  → AI generates reply
3. POST /feedback { user_message, ai_reply } → cc-soul learns
```

That's it. Three calls per message. Your AI gets persistent memory without changing anything else.

### Claude Code (MCP)

```bash
# List available tools
curl http://localhost:18800/mcp/tools
# → cc_memory_search, cc_memory_add, cc_soul_state, cc_persona_info

# Call a tool
curl -X POST http://localhost:18800/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"tool": "cc_memory_search", "args": {"query": "deploy"}}'
```

### A2A Protocol

```bash
# Get agent card
curl http://localhost:18800/.well-known/agent.json

# Send agent-to-agent request
curl -X POST http://localhost:18800/a2a \
  -H "Content-Type: application/json" \
  -d '{"capability": "memory-recall", "params": {"query": "server setup"}}'
```

### Python Example

```python
import requests

API = "http://localhost:18800"

# Step 1: Get augmented context
ctx = requests.post(f"{API}/process", json={
    "message": "What's my server config?",
    "user_id": "alice"
}).json()

# Step 2: Feed to your AI (OpenAI example)
from openai import OpenAI
client = OpenAI()
reply = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": ctx["system_prompt"] + "\n\n" + ctx["augments"]},
        {"role": "user", "content": "What's my server config?"}
    ]
).choices[0].message.content

# Step 3: Feedback
requests.post(f"{API}/feedback", json={
    "user_message": "What's my server config?",
    "ai_reply": reply,
    "user_id": "alice"
})
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

## Things It Does Automatically

Every message is analyzed for memory extraction, entity recognition, emotional signals, and topic tracking. 11 personas blend automatically based on content. Corrections trigger fact-checking and rule learning. Old memories decay intelligently via Weibull survival modeling. Contradictions between memories are detected and flagged. Your knowledge graph grows with entity relationships. Long conversations are compressed to save tokens. Theory of mind tracks your beliefs, knowledge gaps, and frustrations. Persona drift is monitored with Shannon entropy and auto-corrected. Quality scoring learns what response style works best for you.

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

---

## All Commands

**Memory:** `我的记忆` · `搜索记忆 <词>` · `删除记忆 <词>` · `pin 记忆 <词>` · `unpin 记忆 <词>` · `记忆时间线 <词>` · `记忆健康` · `记忆审计` · `恢复记忆 <词>` · `记忆链路 <词>` · `共享记忆 <词>` · `私有记忆 <词>`

**Import/Export:** `导出lorebook` · `导出进化` · `导入进化 <路径>` · `摄入文档 <路径>`

**Daily Life:** `打卡 <习惯>` · `习惯状态` · `新目标 <描述>` · `目标进度 <目标> <更新>` · `我的目标` · `提醒 HH:MM <消息>` · `我的提醒` · `删除提醒 <序号>`

**Status:** `stats` · `soul state` · `晨报` · `周报` · `情绪周报` · `能力评分` · `成长轨迹` · `我的技能` · `metrics` · `cost` · `dashboard` · `记忆图谱 html` · `对话摘要`

**Insights:** `时间旅行 <词>` · `推理链` · `情绪锚点` · `记忆链路 <词>`

**Experience:** `讲讲我们的故事` · `每日复盘` · `保存话题` · `切换话题 <名称>` · `话题列表`

**Advanced:** `功能状态` · `开启 <功能>` · `关闭 <功能>` · `审计日志` · `开始实验 <描述>` · `安装向量` · `向量状态`

---

## Vector Search (Optional)

cc-soul works out of the box with keyword matching (TF-IDF + trigram). For semantic search ("that deployment thing" also finds "set up server on AWS"), download a local embedding model:

| You ask | Keyword mode (default) | Vector mode |
|---------|----------------------|-------------|
| "that deployment thing" | Matches "deployment" only | Also finds "set up server on AWS, SSH port 22" |
| "the bug from last week" | Matches "bug" | Also finds "TypeError crash in auth module" |
| "database stuff" | Matches "database" | Also finds "PostgreSQL connection pool", "Redis cache TTL" |

### Setup (2 minutes)

```bash
mkdir -p ~/.openclaw/plugins/cc-soul/data/models/minilm
cd ~/.openclaw/plugins/cc-soul/data/models/minilm
curl -L -o model.onnx "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx"
curl -L -o vocab.json "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"
```

Or just say `安装向量` / `install vector` — cc-soul downloads everything automatically.

~90MB on disk, ~120MB RAM, ~5ms per query. CPU only, no GPU needed. Restart to activate. Without it, everything works the same — just keyword matching instead of semantic.

---

## Privacy & Security

All data stored locally in `~/.openclaw/plugins/cc-soul/data/`. Nothing ever leaves your machine. No telemetry.

- **Privacy mode** — say `隐私模式` to pause all memory storage
- **PII filtering** — auto-strips emails, phone numbers, API keys, IPs
- **Prompt injection detection** — 9 pattern filters
- **Immutable audit log** — SHA256 chain-linked operation history
- **MCP rate limiting** — prevents abuse from external agents

[SECURITY.md](https://github.com/wenroudeyu-collab/cc-soul/blob/main/SECURITY.md)

---

[npm](https://www.npmjs.com/package/@cc-soul/openclaw) · [GitHub](https://github.com/wenroudeyu-collab/cc-soul) · Issues: [github.com/wenroudeyu-collab/cc-soul/issues](https://github.com/wenroudeyu-collab/cc-soul/issues) · wenroudeyu@gmail.com

*Your AI, but it actually knows you.*
