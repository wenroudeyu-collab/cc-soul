# Changelog

All notable changes to cc-soul will be documented here.

## [1.6.0] - 2026-03-23

### Added
- **New user onboarding**: first-time users get a guided 3-question conversation to build initial profile and memory baseline
- **Multi-language support**: auto-detects English messages and switches soul prompt to English mode
- **"我的记忆" / "my memories" command**: view the 20 most recent memories AI has about you
- **"导出记忆" / "export memories" command**: export all your memories to JSON file
- **"导出灵魂" / "export soul" command**: export soul config (prompt + features + personas + values) for sharing or backup
- **Recall rate visualization**: stats command now shows memory recall success rate
- **Personality growth curve**: stats command shows persona usage histogram with trend analysis (e.g. "主要以工程师模式互动")
- **Persona usage tracking**: every persona selection logged per user for growth visualization
- **OpenClaw hybrid recall**: recall() now queries OpenClaw native FTS5 memory as secondary source, merges results with cc-soul's TF-IDF/trigram
- **OpenClaw 3.22 verified**: full compatibility confirmed — plugin loading, hooks, SOUL.md injection all working

### Fixed
- **SOUL.md content pollution**: core_memory.json had 12 garbage entries ([goal completed], [Working Memory], Rating leaks, persona snapshots) — cleaned data + added reject filter in promoteToCore()
- **System augment memory leak**: addMemory() now rejects content with system prefixes ([Working Memory], [当前面向], [System], etc.)
- **saveMemories() crash protection**: refuses to overwrite non-empty file with empty array (prevents data loss on process kill)
- **Relationship "relatively new" never updating**: familiarity was always 0 — now grows with messageCount (50 msgs → fully familiar)
- **getBlendedPersonaOverlay double selection**: was calling selectPersona() again without intent/msg, always picking analyst — now uses activePersona directly
- **New persona trigger too weak**: extended triggers (planning/learning/curiosity) now override vector similarity when detected from message content
- **"我的记忆" intercepted by upgrade system**: new commands now skip upgrade check to avoid false interception
- **type-mismatch NaN**: Date.now() - m.ts returns NaN when ts is string/undefined (handler.ts, rover.ts)
- **unguarded JSON.parse**: sqlite-store.ts row.tags parsing could crash
- **Claude concurrency false alarm**: excluded cc-soul daemon processes from count, threshold 8→3
- **Feishu notification spam**: notifySoulActivity now console.log only

### Changed
- SOUL.md architecture overhaul: 35.9KB → 5.1KB (86% reduction, 864 tokens)
- Dynamic content (memories, reflections, hypotheses, dreams, entity graph, rover, workflows, user model, values) moved from SOUL.md to per-message augment injection
- 5 new personas (total 10): Strategist, Explorer, Executor, Teacher, Devil's Advocate
- Context protection: 70%/85%/95% three-tier threshold
- Prompt injection detection: 9 regex patterns
- Competitive radar v2: dynamic inventory scan + 10 competitors + comparison matrix
- SoulSpec compatibility: soul.json + STYLE.md + IDENTITY.md + HEARTBEAT.md + SECURITY.md
- Owner-only features hidden from customers
- All 50 modules fully obfuscated (build.sh auto-scan, no manual lists)
- Memory recall: ts=0 repair (4986 memories) + double decay removed + RECALL_UPGRADE_COUNT 2→1 + archival reactivation + multi-route scoring
- Byte-based SOUL.md truncation (19KB limit) for Chinese UTF-8


## [1.5.0] - 2026-03-23

### Major: SOUL.md Architecture Overhaul
- **SOUL.md 86% size reduction**: 35.9KB → 5.1KB (864 tokens, was 4177)
- Dynamic content (memories, reflections, hypotheses, entity graph, dreams, rover, workflows, user model, value guidance) moved from SOUL.md to per-message augment injection
- SOUL.md now contains only: identity + values + speaking style + 举一反三 rules + commands + body state + current speaker
- Byte-based truncation (19KB limit) replaces char-based, correctly handles Chinese UTF-8

### Added
- **5 new personas** (total 10): Strategist (军师), Explorer (探索者), Executor (执行者), Teacher (导师), Devil's Advocate (魔鬼代言人) — all auto-selected by conversation context
- **Extended trigger detection**: message content analysis for planning/learning/curiosity keywords triggers specialized personas
- **Context protection**: 70%/85%/95% three-tier threshold — auto checkpoint at 70%, reduce augments at 85%, emergency trim at 95%
- **Prompt injection detection**: 9 regex patterns (EN/CN) detect injection attempts, inject security warning as augment
- **SECURITY.md**: security framework documentation (data policy, PII filtering, privacy mode, vulnerability reporting)
- **SoulSpec compatibility**: soul.json + STYLE.md + IDENTITY.md + HEARTBEAT.md
- **saveMemories guard**: refuses to overwrite non-empty file with empty array (prevents data loss on crash)
- **Core memory filter**: rejects system augment content ([Working Memory], [当前面向], [goal completed], Rating, etc.)
- **Familiarity tracking**: auto-grows with interaction count (50 messages → fully familiar)

### Fixed
- **Memory recall collapse** (P0): 4986 memories with ts=0 caused age calculation to return 20000+ days → all marked decayed → recall pool collapsed from 5000 to 19 active. Fixed: one-time ts repair + processMemoryDecay null-safe + RECALL_UPGRADE_COUNT 2→1
- **Double decay in recall()** (P0): recency × timeDecay was double-penalizing old memories by 55%. Removed timeDecay multiplication
- **SOUL.md 35.9KB overflow** (P0): exceeded OpenClaw's 20K workspace injection limit. Fixed: byte-based truncation + content migration to augments
- **loadFeatures() overwrite** (P0): every gateway restart overwrote user's feature toggles with defaults. Fixed: only add missing keys, never overwrite existing values
- **getBlendedPersonaOverlay double selection**: was calling selectPersona() again without intent/msg, always picking analyst. Fixed: use activePersona directly
- **Core memory pollution**: system augments ([Working Memory], [goal completed], Rating, persona snapshots) leaked into core_memory.json. Fixed: reject filter + data cleanup
- **Relationship "relatively new"**: familiarity was never updated (always 0). Fixed: grows with messageCount
- **type-mismatch NaN**: Date.now() - m.ts returned NaN when ts was string/undefined (handler.ts, rover.ts)
- **unguarded JSON.parse**: sqlite-store.ts row.tags parsing could crash
- **Claude concurrency false alarm**: excluded cc-soul's own daemon processes from count, threshold 8→3
- **Feishu notification spam**: notifySoulActivity now console.log only, no longer pushes to Feishu group

### Changed
- Owner-only features (self_upgrade, tech_radar, competitive_radar) hidden from customer feature list and chat toggle
- Competitive radar v2: dynamic inventory scan + 10 competitors + comparison matrix
- 4 cognitive modules rewritten: metacognition (419 lines), context-prep (320), patterns (371), meta-feedback (366)
- Archival memory reactivation: decayed memories auto-revive when active recall < 3 results
- Multi-route recall scoring: tag×1.0 + trigram×0.5 + BM25×0.7 cumulative
- Batch tag priority: active memories first, batch size 5→10
- 50 modules, 20,000+ lines, all obfuscated for npm distribution



## [1.4.0] - 2026-03-23

### Architecture
- Migrated from hook to pure OpenClaw plugin (`kind: context-engine`)
- Auto-creates hook bridge at `~/.openclaw/hooks/cc-soul-hook/` for CLI backend compatibility
- SOUL.md file injection for soul prompt (never truncated by bootstrap file limits)
- Plugin auto-configures `openclaw.json` on install (plugin paths, allow list, entries)
- Install script deploys to `~/.openclaw/plugins/` (was `hooks/`); auto-migrates existing data

### Added (P0 — memory engineering)
- Entity/relation time-series management (`valid_at`/`invalid_at`, auto-invalidate 90d stale)
- Memory CRUD decision engine (ADD/UPDATE/SKIP via trigram similarity >0.7 dedup)
- Memory semantic compression (8 regex patterns reduce storage noise)
- Auto-insights during memory consolidation (behavioral pattern discovery from merged memories)

### Added (P1 — features)
- Memory with Search: rover enriches web search results with user preferences and context
- Mermaid memory map visualization (`generateMemoryMap`) — viewable knowledge graph
- Enhanced memory stats: scope distribution, 7-day rolling count, top 5 topics
- 3-tier time-decay memory: `short_term` → `mid_term` → `long_term` with `processMemoryDecay`
- LLM-driven memory operations: auto update/delete based on conversation context
- 举一反三 expanded to 22 domain detectors + 11 life domains (was tech-only)
- Tier-aware responses: patient friendly tone for new users, natural style for owner

### Added (infrastructure)
- Haiku API fallback for background tasks (~$0.06/day)
- Persistent CLI daemon (zero-cost background processing without API calls)
- Execution priority chain: persistent CLI > Haiku API > one-shot CLI
- Context Engine registered via `api.registerContextEngine()` (ready for future OpenClaw CE support)

### Fixed
- 180s timeout: background tasks no longer compete with agent CLI process
- `message:sent` unreliable in plugin mode: post-response analysis moved to N+1 turn
- Soul prompt truncation: SOUL.md bypasses bootstrap file size limits (written to workspace)
- `agentBusy` timeout: reduced 200s → 30s safety release
- CLI `--no-input` flag removed (unsupported in current claude CLI)
- Prompt self-contradiction: core values rewritten to reinforce rather than suppress 举一反三

### Changed
- `federation` + `sync` default OFF (no server required for standalone use)
- `telemetry` default ON but can be disabled (`disable telemetry`)
- Data directory auto-detects `plugins/` or `hooks/` path
- Install script deploys to `~/.openclaw/plugins/` (was `hooks/`)
- 120 user-visible features (was 42)
- 50 modules, 18,062 lines (was 45 modules, 15K lines)

## [1.3.0] - 2026-03-22

### Added
- 举一反三 v3: mandatory output structure with few-shot examples
  - 22 domain-specific detectors (Python/JS/iOS/RE/DB/Docker/Git/HTTP/File/AI/Linux/Architecture + career/finance/health/education/travel/shopping/cooking/relationships/legal/housing/pets)
  - 8 general pattern detectors (how-to/comparison/advice/trouble/opinion/long-msg)
  - Non-tech domains: career, finance, health, education, travel, shopping, cooking, relationships, legal, housing, pets
  - Tier-aware tone: new/known users get patient friendly responses, owner gets natural style
- Complete feature documentation: 42 user-visible features documented (was 30)

### Fixed
- Prompt self-contradiction: "别写论文" and "老板时间重要" were suppressing 举一反三
- Session bootstrap: changes require session reset to take effect (documented)

### Changed
- Output structure enforced for ALL substantive questions (was tech-only)
- Federation and sync default to OFF (user must opt-in)
- Core values rewritten to reinforce rather than suppress 举一反三

## [1.2.1] - 2026-03-22

### Added
- Auto-tune: A/B parameter tuning experiments
- Competitive radar: tech trend monitoring
- Experiment framework: A/B testing infrastructure
- Meta-feedback collection system
- Upgrade experience learning
- Upgrade meta-learning
- Regression test suite (tests.ts)
- 7-dimension system diagnostics (diagnostic.ts)
- Trigram similarity for semantic rule dedup
- Reflexion tracker in evolution system
- Cross-session topic resume ("上次聊的...")
- Atmosphere sensing in cognition pipeline
- Forced CLI mode for self-upgrade (spawnCLIForUpgrade)

### Fixed
- Notifications: Feishu only if configured, console.log fallback for open-source users
- Build: 8 missing modules added to build.sh (was 37 → now 45)
- Git: 6 new Pro modules excluded from GitHub

### Changed
- README rewritten: user-visible features prominent, internal systems summarized

## [1.2.0] - 2026-03-22

### Added
- Episodic memory: structured event chains with lessons
- Emotional arc: 7-day mood history + trend detection
- Strategy replay: record + recall decision traces
- Relationship dynamics: trust/familiarity per user
- Intent anticipation: pre-warm from recent message patterns
- Attention decay: augment budget shrinks with conversation length
- Meta-learning: analyzes the learning system itself
- Persona blending: smooth mix instead of hard switching
- Multi-dimensional frustration: question density + repetition + decay
- Augment category budget: 5 categories with guaranteed representation
- Memory scope index: O(1) lookup by scope
- Health check module: 30-min system monitoring
- Heartbeat timeout protection: 25min force-release
- Correction → Rover linkage: weak domains auto-studied
- Skill Factory lifecycle: opportunity → creation wired
- Core memory: 3-tier MemGPT architecture (Core/Working/Archival)
- Working memory: per-session isolation
- Autonomous goals: multi-step task decomposition + execution

### Fixed
- 19 bugs across audit rounds (tag index drift, data integrity, eval counter reset, JSON parsing, hardcoded spawn, alertness dead zone, etc.)
- history-import.ts comment crash ("sessions is not defined")

## [1.0.8] - 2026-03-21

### Added
- RAG document ingestion: "remember this URL" stores web content as memories
- Personal dashboard: `stats` command shows your memory/quality/body state
- History auto-import: first install scans past OpenClaw sessions for memories
- 3-tier memory: Core (always in prompt) + Working (per-session) + Archival (recalled)
- Autonomous goal loop: multi-step task decomposition + execution + evaluation
- Persona blending: 70% engineer + 30% friend instead of hard switching
- Multi-dimensional frustration: question density + repetition + natural decay
- Augment category budget: guaranteed representation per category + dynamic budget
- Memory scope index: O(1) lookup by scope via Map
- Health check module: monitors data files, memory state, body range
- Heartbeat timeout: 25min force-release prevents stuck lock
- Correction → Rover linkage: corrected domains auto-queued for learning
- Skill Factory lifecycle: opportunity detection now triggers actual creation
- Anonymous telemetry: daily stats to Hub (opt-out: `disable telemetry`)
- Feature toggles: 25 toggleable features via chat or config file
- AI backend auto-detection from openclaw.json (Claude/Codex/Gemini/OpenAI)
- Knowledge Hub: SQLite-based server for multi-instance knowledge sharing
- Hub dashboard: web UI at /dashboard
- Auto-register: first Hub connection auto-creates API key
- Knowledge trust system: trust scoring + expiry + contradiction resolution
- Cross-device sync: JSONL export/import or HTTP push/pull

### Fixed
- 25 bugs across 5 audit rounds (4 critical, 9 high, 12 medium)
- tagMemoryAsync: content-based match instead of index (prevents tag drift)
- Data integrity check: correct [] vs {} based on file type
- computeEval: only resets counters when explicitly requested
- saveJson cancels pending debounce (prevents stale overwrites)
- All JSON parsing uses balanced-brace extraction (no more truncation)
- rover/tasks/upgrade: removed hardcoded spawn('claude'), uses spawnCLI
- PII filter: regex lastIndex properly reset
- Alertness dead zone [0.4, 0.5] fixed
- getUserPeakHour returns -1 for new users (not midnight)
- getRelevantRules: trackHits param prevents double counting
- Flow Map cleanup prevents memory leak
- Knowledge upload-download loop prevention

### Architecture
- 30+ modules, ~9300 lines TypeScript
- Modular split from original 3547-line single file
- 21 self-upgrade architecture rules + safety red lines
- Open-core model: 22 open-source + 13 closed-source modules

## [1.0.0] - 2026-03-21

### Initial Release
- Memory system: semantic tags, TF-IDF, active management, consolidation
- Personality: persona splitting, emotional contagion, soul fingerprint
- Cognition: attention gate, conversation flow, metacognition, epistemic
- Evolution: rules, hypotheses, correction attribution, structured reflection
- Autonomous: dream mode, web rover, autonomous voice
- Network: sync, federation, Knowledge Hub
