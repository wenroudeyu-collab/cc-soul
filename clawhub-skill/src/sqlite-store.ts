/**
 * sqlite-store.ts — SQLite storage layer with optional vector search
 *
 * Uses Node 22 built-in node:sqlite (zero dependencies).
 * sqlite-vec loaded from OpenClaw's node_modules if available.
 * Embedding powered by embedder.ts (optional onnxruntime-node).
 * Falls back gracefully: vec search → tag search → keyword search.
 */

import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { createRequire } from 'module'
import { DATA_DIR, MEMORIES_PATH, REMINDERS_PATH, GRAPH_PATH } from './persistence.ts'
import type { Memory, Entity, Relation } from './types.ts'
import { embed, isEmbedderReady, getEmbedDim } from './embedder.ts'

// Use OpenClaw's official memory.db — single source of truth
const OFFICIAL_DB = resolve(homedir(), '.openclaw/data/memory.db')
const DB_PATH = existsSync(OFFICIAL_DB) ? OFFICIAL_DB : resolve(DATA_DIR, 'soul.db')

// Use globalThis to share db across multiple jiti module instances
const _g = globalThis as any
if (!_g.__ccSoulSqlite) _g.__ccSoulSqlite = { DatabaseSyncCtor: null, db: null, hasVec: false, sqliteReady: false }
const _s = _g.__ccSoulSqlite

// Aliases for convenient access
let DatabaseSyncCtor: any = _s.DatabaseSyncCtor
let db: any = _s.db
let hasVec: boolean = _s.hasVec
let sqliteReady: boolean = _s.sqliteReady

function _syncState() {
  _s.DatabaseSyncCtor = DatabaseSyncCtor; _s.db = db; _s.hasVec = hasVec; _s.sqliteReady = sqliteReady
}
function _loadState() {
  DatabaseSyncCtor = _s.DatabaseSyncCtor; db = _s.db; hasVec = _s.hasVec; sqliteReady = _s.sqliteReady
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

export function initSQLite(): boolean {
  // Check if another call path already initialized (jiti creates separate module instances)
  if (_s.sqliteReady && _s.db) {
    db = _s.db; DatabaseSyncCtor = _s.DatabaseSyncCtor; hasVec = _s.hasVec; sqliteReady = true
    return true
  }
  if (sqliteReady) return true

  // Load DatabaseSync — try multiple approaches (jiti/hook loader / ESM can lack require)
  if (!DatabaseSyncCtor) {
    // Helper: safe require that handles ESM contexts where require is undefined
    const _require = typeof require !== 'undefined' ? require : null

    // Approach 1: direct require (CJS context)
    if (_require) {
      try { DatabaseSyncCtor = _require('node:sqlite').DatabaseSync } catch {}
    }
    // Approach 2: createRequire with various anchor points (works in ESM where require is undefined)
    if (!DatabaseSyncCtor) {
      let metaUrl: string | undefined
      try { metaUrl = new Function('return import.meta.url')() } catch {}
      const anchors = [
        typeof __filename !== 'undefined' ? __filename : undefined,
        metaUrl,
        process.argv[1],
        process.execPath,
      ].filter(Boolean)
      for (const anchor of anchors) {
        try {
          const req = createRequire(anchor as string)
          DatabaseSyncCtor = req('node:sqlite').DatabaseSync
          if (DatabaseSyncCtor) break
        } catch {}
      }
    }
    // Approach 3: use Node's internal module loader
    if (!DatabaseSyncCtor) {
      try { DatabaseSyncCtor = (globalThis as any).process?.mainModule?.require?.('node:sqlite')?.DatabaseSync } catch {}
    }
    if (!DatabaseSyncCtor) {
      console.log(`[cc-soul][sqlite] node:sqlite unavailable (need Node 22+) — using JSON fallback`)
      return false
    }
  }

  try {
    db = new DatabaseSyncCtor(DB_PATH, { allowExtension: true })
  } catch (e: any) {
    console.error(`[cc-soul][sqlite] failed to open ${DB_PATH}: ${e.message}`)
    return false
  }

  // Try loading sqlite-vec for vector search
  // Method 1: require() the npm module
  const _req = typeof require !== 'undefined' ? require : null
  const vecModulePaths = [
    'sqlite-vec',
    resolve(process.execPath, '../../lib/node_modules/openclaw/node_modules/sqlite-vec'),
  ]
  for (const p of vecModulePaths) {
    if (!_req) break
    try {
      const sqliteVec = _req(p)
      sqliteVec.load(db)
      hasVec = true
      console.log(`[cc-soul][sqlite] sqlite-vec loaded via require: ${p}`)
      break
    } catch { /* try next */ }
  }
  // Method 2: loadExtension() with direct .dylib path (works when require fails)
  if (!hasVec) {
    const dylibPaths = [
      resolve(process.execPath, '../../lib/node_modules/openclaw/node_modules/sqlite-vec-darwin-arm64/vec0.dylib'),
      resolve(homedir(), '.nvm/versions/node/v22.22.1/lib/node_modules/openclaw/node_modules/sqlite-vec-darwin-arm64/vec0.dylib'),
    ]
    for (const p of dylibPaths) {
      try {
        db.loadExtension(p)
        hasVec = true
        console.log(`[cc-soul][sqlite] sqlite-vec loaded via dylib: ${p}`)
        break
      } catch { /* try next */ }
    }
  }

  if (!hasVec) {
    console.log(`[cc-soul][sqlite] running without sqlite-vec (tag-based fallback)`)
  }

  // Schema — use official memories table, add cc-soul columns if missing
  // Official table already has: id, scope, content, created_at, raw_line, access_count, last_accessed
  // We ADD cc-soul specific columns (ALTER TABLE ADD COLUMN is safe — ignores if exists via try/catch)
  const ccSoulColumns: [string, string][] = [
    ['ts', 'INTEGER'],
    ['emotion', "TEXT DEFAULT 'neutral'"],
    ['userId', 'TEXT'],
    ['visibility', "TEXT DEFAULT 'global'"],
    ['channelId', 'TEXT'],
    ['tags', "TEXT DEFAULT '[]'"],
    ['confidence', 'REAL DEFAULT 0.7'],
    ['lastAccessed', 'INTEGER'],
    ['tier', "TEXT DEFAULT 'short_term'"],
    ['recallCount', 'INTEGER DEFAULT 0'],
    ['lastRecalled', 'INTEGER'],
    ['validFrom', 'INTEGER'],
    ['validUntil', 'INTEGER'],
  ]
  for (const [col, def] of ccSoulColumns) {
    try { db.exec(`ALTER TABLE memories ADD COLUMN ${col} ${def}`) } catch { /* already exists */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope)') } catch { /* ok */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_mem_ts ON memories(ts)') } catch { /* ok */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_mem_vis ON memories(visibility)') } catch { /* ok */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(userId)') } catch { /* ok */ }

  // Chat history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_msg TEXT NOT NULL,
      assistant_msg TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_history(ts);
  `)

  // Vector table (only if sqlite-vec available)
  if (hasVec) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mem_vec USING vec0(
        memory_id INTEGER PRIMARY KEY,
        embedding float[${getEmbedDim()}]
      )`)
      console.log(`[cc-soul][sqlite] vector table ready (${getEmbedDim()} dimensions)`)
    } catch (e: any) {
      console.error(`[cc-soul][sqlite] vec table failed: ${e.message}`)
      hasVec = false
    }
  }

  sqliteReady = true
  _syncState() // Share db connection across jiti module instances

  // Trigger embedding backfill if embedder + vec available (delayed, non-blocking)
  if (hasVec) {
    setTimeout(() => {
      if (isEmbedderReady()) {
        backfillEmbeddings(200).catch(() => {})
      } else {
        // Embedder may init later — retry once after 5s
        setTimeout(() => {
          if (isEmbedderReady()) backfillEmbeddings(200).catch(() => {})
        }, 5000)
      }
    }, 2000)
  }

  // ── Entity graph: ALTER TABLE to add cc-soul columns ──
  const entityColumns: [string, string][] = [
    ['mentions', 'INTEGER DEFAULT 0'],
    ['firstSeen', 'INTEGER'],
    ['attrs', "TEXT DEFAULT '[]'"],
    ['valid_at', 'INTEGER DEFAULT 0'],
    ['invalid_at', 'INTEGER'],
  ]
  for (const [col, def] of entityColumns) {
    try { db.exec(`ALTER TABLE entities ADD COLUMN ${col} ${def}`) } catch { /* already exists */ }
  }
  const relationColumns: [string, string][] = [
    ['ts', 'INTEGER'],
    ['valid_at', 'INTEGER DEFAULT 0'],
    ['invalid_at', 'INTEGER'],
  ]
  for (const [col, def] of relationColumns) {
    try { db.exec(`ALTER TABLE relations ADD COLUMN ${col} ${def}`) } catch { /* already exists */ }
  }

  // Auto-migrate cc-soul data from JSON to official DB on first connect
  migrateFromJSON()
  migrateHabitsFromJSON()
  migrateGoalsFromJSON()
  migrateRemindersFromJSON()
  migrateGraphFromJSON()

  const count = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any)?.c || 0
  console.log(`[cc-soul][sqlite] database ready: ${count} memories, vec: ${hasVec}, db: ${DB_PATH}`)
  return true
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATE from JSON
// ═══════════════════════════════════════════════════════════════════════════════

export function migrateFromJSON() {
  if (!db) return

  // Check if cc-soul data already migrated (look for cc-soul specific scope values)
  const ccSoulCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope IN ('fact','short_term','mid_term','long_term','pinned','correction','discovery','visual','preference','consolidated')").get() as any)?.c || 0
  if (ccSoulCount > 0) return // already migrated

  if (!existsSync(MEMORIES_PATH)) return

  try {
    const memories: Memory[] = JSON.parse(readFileSync(MEMORIES_PATH, 'utf-8'))
    if (!Array.isArray(memories) || memories.length === 0) return

    console.log(`[cc-soul][sqlite] migrating ${memories.length} memories from JSON...`)

    const insert = db.prepare(`
      INSERT OR IGNORE INTO memories (content, scope, ts, created_at, raw_line, emotion, userId, visibility, channelId, tags, confidence, lastAccessed, access_count, tier, recallCount, lastRecalled, validFrom, validUntil)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    db.exec('BEGIN')
    try {
      for (const m of memories) {
        if (m.scope === 'expired') continue
        const tsVal = m.ts || Date.now()
        insert.run(
          m.content,
          m.scope,
          tsVal,
          new Date(tsVal).toISOString(),
          m.content.slice(0, 200),
          m.emotion || 'neutral',
          m.userId || null,
          m.visibility || 'global',
          m.channelId || null,
          JSON.stringify(m.tags || []),
          m.confidence ?? 0.7,
          m.lastAccessed || null,
          0,
          m.tier || 'short_term',
          m.recallCount || 0,
          m.lastRecalled || null,
          m.validFrom || null,
          m.validUntil || null,
        )
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    const migrated = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as any)?.c || 0
    console.log(`[cc-soul][sqlite] migrated ${migrated} memories to SQLite`)
  } catch (e: any) {
    console.error(`[cc-soul][sqlite] migration failed: ${e.message}`)
  }
}

/**
 * Migrate chat history from JSON to SQLite.
 */
export function migrateHistoryFromJSON(historyPath: string) {
  if (!db) return
  const count = (db.prepare('SELECT COUNT(*) as c FROM chat_history').get() as any)?.c || 0
  if (count > 0) return

  if (!existsSync(historyPath)) return

  try {
    const history = JSON.parse(readFileSync(historyPath, 'utf-8'))
    if (!Array.isArray(history) || history.length === 0) return

    console.log(`[cc-soul][sqlite] migrating ${history.length} chat turns from JSON...`)

    const insert = db.prepare('INSERT INTO chat_history (user_msg, assistant_msg, ts) VALUES (?, ?, ?)')
    db.exec('BEGIN')
    try {
      for (const turn of history) {
        insert.run(turn.user || '', turn.assistant || '', turn.ts || Date.now())
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    console.log(`[cc-soul][sqlite] migrated ${history.length} chat turns to SQLite`)
  } catch (e: any) {
    console.error(`[cc-soul][sqlite] chat history migration failed: ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY CRUD
// ═══════════════════════════════════════════════════════════════════════════════

export function sqliteAddMemory(mem: Omit<Memory, 'relevance'>): number {
  if (!db) return -1
  const now = Date.now()
  const tsVal = mem.ts || now
  const result = db.prepare(`
    INSERT OR IGNORE INTO memories (content, scope, ts, created_at, raw_line, emotion, userId, visibility, channelId, tags, confidence, lastAccessed, access_count, tier, recallCount, validFrom, validUntil)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mem.content,
    mem.scope,
    tsVal,
    new Date(tsVal).toISOString(),  // official field
    mem.content.slice(0, 200),       // official field
    mem.emotion || 'neutral',
    mem.userId || null,
    mem.visibility || 'global',
    mem.channelId || null,
    JSON.stringify(mem.tags || []),
    mem.confidence ?? 0.7,
    mem.lastAccessed || now,
    0,                                // official access_count
    mem.tier || 'short_term',
    mem.recallCount || 0,
    mem.validFrom || null,
    mem.validUntil || null,
  )
  const id = Number(result.lastInsertRowid)

  // Async: generate and store embedding if embedder is ready
  if (hasVec && isEmbedderReady()) {
    storeEmbeddingAsync(id, mem.content)
  }

  return id
}

export function sqliteUpdateMemory(id: number, updates: Partial<Memory>) {
  if (!db) return
  const sets: string[] = []
  const values: any[] = []
  if (updates.scope !== undefined) { sets.push('scope = ?'); values.push(updates.scope) }
  if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content) }
  if (updates.emotion !== undefined) { sets.push('emotion = ?'); values.push(updates.emotion) }
  if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)) }
  if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence) }
  if (updates.lastAccessed !== undefined) { sets.push('lastAccessed = ?'); values.push(updates.lastAccessed) }
  if (updates.tier !== undefined) { sets.push('tier = ?'); values.push(updates.tier) }
  if (updates.recallCount !== undefined) { sets.push('recallCount = ?'); values.push(updates.recallCount) }
  if (updates.lastRecalled !== undefined) { sets.push('lastRecalled = ?'); values.push(updates.lastRecalled) }
  if (updates.validUntil !== undefined) { sets.push('validUntil = ?'); values.push(updates.validUntil) }
  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  // Re-embed if content changed
  if (updates.content && hasVec && isEmbedderReady()) {
    storeEmbeddingAsync(id, updates.content)
  }
}

/**
 * Update the raw_line column for DAG archiving (preserves original content).
 */
export function sqliteUpdateRawLine(id: number, rawLine: string): void {
  if (!db) return
  db.prepare('UPDATE memories SET raw_line = ? WHERE id = ?').run(rawLine, id)
}

export function sqliteExpireMemory(keyword: string): number {
  if (!db) return 0
  const result = db.prepare(`UPDATE memories SET scope = 'expired' WHERE content LIKE ? AND scope != 'expired'`).run(`%${keyword}%`)
  return result.changes
}

export function sqliteGetByScope(scope: string, limit = 100): Memory[] {
  if (!db) return []
  const rows = db.prepare('SELECT * FROM memories WHERE scope = ? ORDER BY ts DESC LIMIT ?').all(scope, limit) as any[]
  return rows.map(rowToMemory)
}

export function sqliteGetAll(excludeExpired = true): Memory[] {
  if (!db) return []
  const where = excludeExpired ? "WHERE scope != 'expired'" : ''
  return (db.prepare(`SELECT * FROM memories ${where} ORDER BY ts DESC`).all() as any[]).map(rowToMemory)
}

export function sqliteCount(): number {
  if (!db) return 0
  return (db.prepare("SELECT COUNT(*) as c FROM memories WHERE scope != 'expired'").get() as any)?.c || 0
}

/**
 * Find memory by content (for dedup/update). Returns {id, memory} or null.
 */
export function sqliteFindByContent(content: string): { id: number; memory: Memory } | null {
  if (!db) return null
  const row = db.prepare('SELECT * FROM memories WHERE content = ? AND scope != ? LIMIT 1').get(content, 'expired') as any
  if (!row) return null
  return { id: row.id, memory: rowToMemory(row) }
}

/**
 * Find memories similar to content using LIKE (for trigram-style matching).
 * Returns up to `limit` results.
 */
export function sqliteSearchContent(keywords: string[], limit = 20): { id: number; memory: Memory }[] {
  if (!db || keywords.length === 0) return []
  // Build WHERE with OR for each keyword
  const conditions = keywords.map(() => 'content LIKE ?').join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  const rows = db.prepare(
    `SELECT * FROM memories WHERE (${conditions}) AND scope != 'expired' ORDER BY ts DESC LIMIT ?`
  ).all(...params, limit) as any[]
  return rows.map(row => ({ id: row.id, memory: rowToMemory(row) }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECALL — vector search (primary when available) + tag/keyword fallback
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recall memories relevant to msg. Uses vector search if available, falls back to tag/keyword.
 */
export async function sqliteRecall(msg: string, topN = 3, userId?: string, channelId?: string): Promise<Memory[]> {
  if (!db) return []

  // Try vector search first
  if (hasVec && isEmbedderReady()) {
    const vecResults = await vectorRecall(msg, topN * 3, userId, channelId) // over-fetch for re-ranking
    if (vecResults.length > 0) {
      return vecResults.slice(0, topN)
    }
  }

  // Fallback: tag/keyword search (synchronous)
  return tagRecall(msg, topN, userId, channelId)
}

/**
 * Synchronous tag/keyword recall — used as fallback when vectors unavailable.
 */
export function tagRecall(msg: string, topN = 3, userId?: string, channelId?: string): Memory[] {
  if (!db) return []

  const queryWords = (msg.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) || []).map(w => w.toLowerCase())
  if (queryWords.length === 0) return []

  let visWhere = "AND scope != 'expired'"
  const params: any[] = []
  if (channelId) {
    visWhere += ` AND (visibility = 'global' OR (visibility = 'channel' AND channelId = ?))`
    params.push(channelId)
  }
  if (userId) {
    visWhere += ` AND (visibility != 'private' OR userId = ?)`
    params.push(userId)
  }

  // Search both recent memories AND preference/wal/fact memories (which are often older but important)
  const all = db.prepare(`SELECT * FROM memories WHERE 1=1 ${visWhere} ORDER BY ts DESC LIMIT 500`).all(...params) as any[]
  // Also include important scopes that might be older
  const important = db.prepare(`SELECT * FROM memories WHERE scope IN ('preference','wal','fact','consolidated','pinned') ${visWhere} ORDER BY ts DESC LIMIT 100`).all(...params) as any[]
  const seenIds = new Set(all.map((r: any) => r.id))
  for (const r of important) { if (!seenIds.has(r.id)) { all.push(r); seenIds.add(r.id) } }

  const scored: (Memory & { score: number })[] = []
  for (const row of all) {
    const mem = rowToMemory(row)
    let sim = 0

    const tags: string[] = mem.tags || []
    if (tags.length > 0) {
      let hits = 0
      for (const qw of queryWords) {
        for (const tag of tags) {
          if (tag.includes(qw) || qw.includes(tag)) { hits++; break }
        }
      }
      sim = hits / Math.max(1, queryWords.length)
    } else {
      const content = mem.content.toLowerCase()
      const hits = queryWords.filter(w => content.includes(w)).length
      sim = hits / Math.max(1, queryWords.length) * 0.7
    }

    if (sim < 0.05) continue

    const ageDays = (Date.now() - mem.ts) / 86400000
    const recency = Math.exp(-ageDays * 0.02)
    const scopeBoost = (mem.scope === 'preference' || mem.scope === 'fact') ? 1.3
      : (mem.scope === 'correction') ? 1.5
      : (mem.scope === 'consolidated') ? 1.5
      : 1.0
    const emotionBoost = mem.emotion === 'important' ? 1.4
      : mem.emotion === 'painful' ? 1.3
      : mem.emotion === 'warm' ? 1.2
      : 1.0
    const userBoost = (userId && mem.userId === userId) ? 1.3 : 1.0
    const confidenceWeight = mem.confidence ?? 0.7
    // DAG archive: archived memories participate with reduced weight
    const archiveWeight = mem.scope === 'archived' ? 0.3 : 1.0
    // ── Parity with recallWithScores: add missing 5 dimensions ──
    const usageBoost = (mem.tags && mem.tags.length > 5) ? 1.2 : 1.0
    const consolidatedBoost = mem.scope === 'consolidated' ? 1.5 : mem.scope === 'pinned' ? 2.0 : 1.0
    const lastAcc = mem.lastAccessed || mem.ts || 0
    const accAgeDays = (Date.now() - lastAcc) / 86400000
    const tierWeight = ((accAgeDays <= 1 || (mem.recallCount ?? 0) >= 5) ? 1.5
                      : (accAgeDays <= 7) ? 1.0
                      : (accAgeDays <= 30) ? 0.8 : 0.5)
    const temporalWeight = (mem.validUntil && mem.validUntil > 0 && mem.validUntil < Date.now()) ? 0.3 : 1.0

    scored.push({ ...mem, score: sim * recency * scopeBoost * emotionBoost * userBoost * confidenceWeight * archiveWeight * usageBoost * consolidatedBoost * tierWeight * temporalWeight })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN)
}

/**
 * Vector-based recall using sqlite-vec + embedder.
 */
async function vectorRecall(msg: string, topN: number, userId?: string, channelId?: string): Promise<Memory[]> {
  const queryVec = await embed(msg)
  if (!queryVec) return []

  try {
    // sqlite-vec KNN query
    const vecRows = db.prepare(`
      SELECT memory_id, distance
      FROM mem_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(queryVec.buffer), topN * 2) as any[]

    if (vecRows.length === 0) return []

    // Fetch full memory rows
    const ids = vecRows.map((r: any) => r.memory_id)
    const distMap = new Map(vecRows.map((r: any) => [r.memory_id, r.distance]))

    const placeholders = ids.map(() => '?').join(',')
    let visWhere = `AND scope != 'expired'`
    const params: any[] = [...ids]
    if (channelId) {
      visWhere += ` AND (visibility = 'global' OR (visibility = 'channel' AND channelId = ?))`
      params.push(channelId)
    }
    if (userId) {
      visWhere += ` AND (visibility != 'private' OR userId = ?)`
      params.push(userId)
    }

    const rows = db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) ${visWhere}`
    ).all(...params) as any[]

    // Score: combine vector similarity with recency/scope/emotion boosts
    const scored: (Memory & { score: number })[] = []
    for (const row of rows) {
      const mem = rowToMemory(row)
      const dist = distMap.get(row.id) || 1.0
      const vecSim = 1.0 - dist // cosine distance → similarity

      if (vecSim < 0.3) continue // too dissimilar

      const ageDays = (Date.now() - mem.ts) / 86400000
      const recency = Math.exp(-ageDays * 0.02)
      const scopeBoost = (mem.scope === 'correction') ? 1.5
        : (mem.scope === 'preference' || mem.scope === 'fact' || mem.scope === 'consolidated') ? 1.3
        : 1.0
      const emotionBoost = mem.emotion === 'important' ? 1.4
        : mem.emotion === 'painful' ? 1.3
        : 1.0
      const confidenceWeight = mem.confidence ?? 0.7
      // DAG archive: archived memories participate with reduced weight
      const archiveWeight = mem.scope === 'archived' ? 0.3 : 1.0

      scored.push({ ...mem, score: vecSim * recency * scopeBoost * emotionBoost * confidenceWeight * archiveWeight })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored
  } catch (e: any) {
    console.error(`[cc-soul][sqlite] vector recall failed: ${e.message}`)
    return []
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMBEDDING MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Store embedding for a memory (async, fire-and-forget).
 */
function storeEmbeddingAsync(memoryId: number, content: string) {
  embed(content).then(vec => {
    if (!vec || !db || !hasVec) return
    try { db.exec('SELECT 1') } catch { return } // db may have been closed
    try {
      // Upsert: delete old if exists, then insert — wrapped in transaction for atomicity
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM mem_vec WHERE memory_id = ?').run(memoryId)
        db.prepare('INSERT INTO mem_vec (memory_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
          memoryId,
          Buffer.from(vec.buffer),
        )
        db.exec('COMMIT')
      } catch (innerErr) {
        db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (e: any) {
      console.error(`[cc-soul][sqlite] embed store failed for id=${memoryId}: ${e.message}`)
    }
  }).catch(() => { /* silent */ })
}

/**
 * Backfill embeddings for memories that don't have vectors yet.
 * Called from heartbeat. Processes a small batch each time.
 */
export async function backfillEmbeddings(batchSize = 200) {
  const _db = ensureDb()
  _loadState()
  if (!_db || !hasVec || !isEmbedderReady()) {
    console.log(`[cc-soul][sqlite] backfill skipped: db=${!!_db} hasVec=${hasVec} embedderReady=${isEmbedderReady()}`)
    return
  }

  try {
    const rows = _db.prepare(`
      SELECT m.id, m.content FROM memories m
      LEFT JOIN mem_vec v ON m.id = v.memory_id
      WHERE v.memory_id IS NULL AND m.scope != 'expired'
      LIMIT ?
    `).all(batchSize) as any[]

    if (rows.length === 0) return

    let stored = 0
    for (const row of rows) {
      const vec = await embed(row.content)
      if (!vec) continue
      try {
        _db.prepare('DELETE FROM mem_vec WHERE memory_id = ?').run(row.id)
        _db.prepare('INSERT INTO mem_vec (memory_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
          row.id,
          Buffer.from(vec.buffer),
        )
        stored++
      } catch { /* skip */ }
    }

    if (stored > 0) {
      console.log(`[cc-soul][sqlite] backfilled ${stored}/${rows.length} embeddings`)
    }
  } catch (e: any) {
    console.error(`[cc-soul][sqlite] backfill failed: ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT HISTORY CRUD
// ═══════════════════════════════════════════════════════════════════════════════

export function sqliteAddChatTurn(user: string, assistant: string) {
  if (!db) return
  db.prepare('INSERT INTO chat_history (user_msg, assistant_msg, ts) VALUES (?, ?, ?)').run(
    user.slice(0, 1000),
    assistant.slice(0, 2000),
    Date.now(),
  )
}

export function sqliteGetRecentHistory(limit = 30): { user: string; assistant: string; ts: number }[] {
  if (!db) return []
  const rows = db.prepare('SELECT * FROM chat_history ORDER BY ts DESC LIMIT ?').all(limit) as any[]
  return rows.reverse().map(row => ({
    user: row.user_msg,
    assistant: row.assistant_msg,
    ts: row.ts,
  }))
}

export function sqliteTrimHistory(maxKeep = 100) {
  if (!db) return
  const count = (db.prepare('SELECT COUNT(*) as c FROM chat_history').get() as any)?.c || 0
  if (count <= maxKeep) return
  const cutoff = db.prepare('SELECT ts FROM chat_history ORDER BY ts DESC LIMIT 1 OFFSET ?').get(maxKeep) as any
  if (cutoff) {
    db.prepare('DELETE FROM chat_history WHERE ts < ?').run(cutoff.ts)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════════

export function sqliteCleanupExpired() {
  if (!db) return
  const cutoff = Date.now() - 30 * 86400000
  // Clean up expired memories and their vectors
  const expiredIds = db.prepare("SELECT id FROM memories WHERE scope = 'expired' AND ts < ?").all(cutoff) as any[]
  if (expiredIds.length > 0) {
    const ids = expiredIds.map((r: any) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    if (hasVec) {
      try { db.prepare(`DELETE FROM mem_vec WHERE memory_id IN (${placeholders})`).run(...ids) } catch { /* ok */ }
    }
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids)
    console.log(`[cc-soul][sqlite] cleaned up ${ids.length} expired memories`)
  }
}

export function sqliteVacuum() {
  if (!db) return
  try { db.exec('VACUUM') } catch { /* ignore */ }
}

export function hasVectorSearch(): boolean {
  return hasVec && isEmbedderReady()
}

export function isSQLiteReady(): boolean {
  return sqliteReady
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function rowToMemory(row: any): Memory {
  // ts: cc-soul uses INTEGER ms; official uses created_at TEXT — handle both
  let ts = row.ts
  if (!ts && row.created_at) {
    try { ts = new Date(row.created_at).getTime() } catch { ts = Date.now() }
  }
  return {
    content: row.content,
    scope: row.scope,
    ts: ts || Date.now(),
    emotion: row.emotion || 'neutral',
    userId: row.userId || undefined,
    visibility: row.visibility || 'global',
    channelId: row.channelId || undefined,
    tags: row.tags ? (() => { try { return JSON.parse(row.tags) } catch { return [] } })() : [],
    confidence: row.confidence ?? 0.7,
    lastAccessed: row.lastAccessed || row.last_accessed ? new Date(row.last_accessed).getTime() : undefined,
    tier: row.tier || 'short_term',
    recallCount: row.recallCount ?? row.access_count ?? 0,
    lastRecalled: row.lastRecalled || undefined,
    validFrom: row.validFrom || undefined,
    validUntil: row.validUntil || undefined,
  }
}

/** Ensure db is initialized, return the connection. Retries if previous attempt failed. */
function ensureDb(): any {
  _loadState()
  if (db) return db
  if (!sqliteReady) {
    try { initSQLite() } catch { /* init failed, db stays null */ }
    _loadState() // check if another context succeeded
  }
  return db
}

export function getDb() { return ensureDb() }

// ═══════════════════════════════════════════════════════════════════════════════
// HABITS CRUD — uses official habits + habit_logs tables
// ═══════════════════════════════════════════════════════════════════════════════

export function dbGetHabits(chatId?: string): { id: number; name: string; streak: number; total: number; lastDate: string }[] {
  const _db = ensureDb(); if (!_db) return []
  const rows = _db.prepare(`
    SELECT h.id, h.name, h.description,
      (SELECT COUNT(*) FROM habit_logs WHERE habit_id = h.id) as total,
      (SELECT MAX(date) FROM habit_logs WHERE habit_id = h.id) as lastDate
    FROM habits h WHERE h.archived = 0
    ORDER BY h.name
  `).all() as any[]
  return rows.map(r => {
    // Calculate streak from habit_logs
    let streak = 0
    const logs = _db.prepare('SELECT date FROM habit_logs WHERE habit_id = ? ORDER BY date DESC').all(r.id) as any[]
    const today = new Date().toISOString().slice(0, 10)
    let checkDate = today
    for (const l of logs) {
      if (l.date === checkDate || l.date === prevDay(checkDate)) {
        streak++
        checkDate = l.date
      } else break
    }
    return { id: r.id, name: r.name, streak, total: r.total || 0, lastDate: r.lastDate || '' }
  })
}

function prevDay(dateStr: string): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function dbCheckin(habitName: string, chatId?: string): { streak: number; total: number; isNew: boolean } {
  let _db = ensureDb()
  // If db not ready yet (concurrent init), retry once after reloading state
  if (!_db) {
    _loadState()
    _db = ensureDb()
  }
  if (!_db) return { streak: 0, total: 0, isNew: false }
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()

  // Find or create habit
  let habit = _db.prepare('SELECT id FROM habits WHERE name = ? AND archived = 0').get(habitName) as any
  let isNew = false
  if (!habit) {
    _db.prepare('INSERT INTO habits (name, frequency, chat_id, created_at) VALUES (?, ?, ?, ?)').run(habitName, 'daily', chatId || '', now)
    habit = _db.prepare('SELECT id FROM habits WHERE name = ? AND archived = 0').get(habitName) as any
    isNew = true
  }

  // Check if already checked in today
  const existing = _db.prepare('SELECT id FROM habit_logs WHERE habit_id = ? AND date = ?').get(habit.id, today) as any
  if (!existing) {
    _db.prepare('INSERT INTO habit_logs (habit_id, date, value, created_at) VALUES (?, ?, 1, ?)').run(habit.id, today, now)
  }

  // Calculate streak + total
  const total = (_db.prepare('SELECT COUNT(*) as c FROM habit_logs WHERE habit_id = ?').get(habit.id) as any)?.c || 0
  const logs = _db.prepare('SELECT date FROM habit_logs WHERE habit_id = ? ORDER BY date DESC LIMIT 60').all(habit.id) as any[]
  let streak = 0
  let checkDate = today
  for (const l of logs) {
    if (l.date === checkDate) { streak++; checkDate = prevDay(checkDate) }
    else if (l.date === prevDay(checkDate)) { streak++; checkDate = prevDay(l.date) }
    else break
  }

  return { streak, total, isNew }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOALS CRUD — uses official goals + goal_updates tables
// ═══════════════════════════════════════════════════════════════════════════════

export function dbGetGoals(chatId?: string): { id: number; name: string; progress: number; milestones: number; created: number }[] {
  const _db = ensureDb(); if (!_db) return []
  const rows = _db.prepare(`
    SELECT g.id, g.title, g.progress, g.created_at,
      (SELECT COUNT(*) FROM key_results WHERE goal_id = g.id) as milestones
    FROM goals g WHERE g.status != 'completed'
    ORDER BY g.created_at DESC
  `).all() as any[]
  return rows.map(r => ({
    id: r.id,
    name: r.title,
    progress: r.progress || 0,
    milestones: r.milestones || 0,
    created: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  }))
}

export function dbAddGoal(name: string, chatId?: string): number {
  const _db = ensureDb(); if (!_db) return -1
  const now = new Date().toISOString()
  const result = _db.prepare('INSERT INTO goals (title, status, progress, chat_id, created_at) VALUES (?, ?, 0, ?, ?)').run(name, 'active', chatId || '', now)
  return Number(result.lastInsertRowid)
}

export function dbUpdateGoalProgress(goalId: number, progress: number, note?: string) {
  const _db = ensureDb(); if (!_db) return
  _db.prepare('UPDATE goals SET progress = ? WHERE id = ?').run(progress, goalId)
  if (note) {
    _db.prepare('INSERT INTO goal_updates (goal_id, content, progress_delta, created_at) VALUES (?, ?, ?, ?)').run(goalId, note, progress, new Date().toISOString())
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REMINDERS CRUD — uses official reminders table
// ═══════════════════════════════════════════════════════════════════════════════

export function dbGetReminders(userId?: string): { id: number; msg: string; hour: number; minute: number; repeat: boolean; userId: string }[] {
  const _db = ensureDb(); if (!_db) return []
  const rows = _db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY remind_at ASC").all() as any[]
  return rows
    .filter(r => !userId || !r.chat_id || r.chat_id === userId)
    .map(r => {
      // Parse remind_at (stored as "HH:MM" or ISO datetime)
      let hour = 0, minute = 0
      const timeStr = r.remind_at || ''
      const hm = timeStr.match(/(\d{1,2}):(\d{2})/)
      if (hm) { hour = parseInt(hm[1]); minute = parseInt(hm[2]) }
      return {
        id: r.id,
        msg: r.content,
        hour, minute,
        repeat: r.repeat_type === 'daily',
        userId: r.chat_id || '',
      }
    })
}

export function dbAddReminder(msg: string, hour: number, minute: number, userId?: string): number {
  const _db = ensureDb(); if (!_db) return -1
  const now = new Date().toISOString()
  const remindAt = `${hour}:${String(minute).padStart(2, '0')}`
  const result = _db.prepare("INSERT INTO reminders (chat_id, content, remind_at, repeat_type, status, created_at) VALUES (?, ?, ?, 'daily', 'pending', ?)").run(userId || '', msg, remindAt, now)
  return Number(result.lastInsertRowid)
}

export function dbDeleteReminder(id: number) {
  const _db = ensureDb(); if (!_db) return
  _db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(id)
}

export function dbGetDueReminders(): { id: number; msg: string; userId: string; lastFired: string | null }[] {
  const _db = ensureDb(); if (!_db) return []
  const now = new Date()
  const h = now.getHours(), m = now.getMinutes()
  const rows = _db.prepare("SELECT * FROM reminders WHERE status = 'pending'").all() as any[]
  const due: any[] = []
  for (const r of rows) {
    const hm = (r.remind_at || '').match(/(\d{1,2}):(\d{2})/)
    if (!hm) continue
    const rh = parseInt(hm[1]), rm = parseInt(hm[2])
    const diffMin = Math.abs((rh * 60 + rm) - (h * 60 + m))
    if (diffMin <= 15 || diffMin >= (24 * 60 - 15)) {
      if (r.last_fired && Date.now() - new Date(r.last_fired).getTime() < 25 * 60000) continue
      due.push({ id: r.id, msg: r.content, userId: r.chat_id || '', lastFired: r.last_fired })
    }
  }
  return due
}

export function dbMarkReminderFired(id: number) {
  const _db = ensureDb(); if (!_db) return
  _db.prepare("UPDATE reminders SET last_fired = ?, fired_count = COALESCE(fired_count, 0) + 1 WHERE id = ?").run(new Date().toISOString(), id)
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT REMINDERS — keyword-triggered reminders (repeat_type = 'context')
// ═══════════════════════════════════════════════════════════════════════════════

export function dbAddContextReminder(keyword: string, content: string, userId?: string): number {
  const _db = ensureDb(); if (!_db) return -1
  const now = new Date().toISOString()
  // remind_at stores the keyword, repeat_type = 'context'
  const result = _db.prepare(
    "INSERT INTO reminders (chat_id, content, remind_at, repeat_type, status, created_at) VALUES (?, ?, ?, 'context', 'pending', ?)"
  ).run(userId || '', content, keyword, now)
  return Number(result.lastInsertRowid)
}

export function dbGetContextReminders(userId?: string): { id: number; keyword: string; content: string; userId: string }[] {
  const _db = ensureDb(); if (!_db) return []
  const rows = _db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND repeat_type = 'context'").all() as any[]
  return rows
    .filter(r => !userId || !r.chat_id || r.chat_id === userId)
    .map(r => ({
      id: r.id,
      keyword: r.remind_at || '',
      content: r.content || '',
      userId: r.chat_id || '',
    }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATE habits/goals/reminders from JSON
// ═══════════════════════════════════════════════════════════════════════════════

export function migrateHabitsFromJSON() {
  const _db = ensureDb(); if (!_db) return
  const habitsPath = resolve(DATA_DIR, 'habits.json')
  if (!existsSync(habitsPath)) return
  const existing = (_db.prepare('SELECT COUNT(*) as c FROM habits').get() as any)?.c || 0
  if (existing > 0) return
  try {
    const raw = JSON.parse(readFileSync(habitsPath, 'utf-8'))
    const now = new Date().toISOString()
    _db.exec('BEGIN')
    for (const [name, data] of Object.entries(raw) as [string, any][]) {
      _db.prepare('INSERT OR IGNORE INTO habits (name, frequency, created_at) VALUES (?, ?, ?)').run(name, 'daily', now)
      const habit = _db.prepare('SELECT id FROM habits WHERE name = ?').get(name) as any
      if (habit && data.checkins) {
        for (const dateStr of (data.checkins || [])) {
          _db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, date, value, created_at) VALUES (?, ?, 1, ?)').run(habit.id, dateStr, now)
        }
      }
    }
    _db.exec('COMMIT')
    console.log(`[cc-soul][sqlite] migrated habits from JSON`)
  } catch (e: any) {
    try { _db.exec('ROLLBACK') } catch {}
    console.error(`[cc-soul][sqlite] habits migration failed: ${e.message}`)
  }
}

export function migrateGoalsFromJSON() {
  const _db = ensureDb(); if (!_db) return
  const goalsPath = resolve(DATA_DIR, 'user-goals.json')
  if (!existsSync(goalsPath)) return
  const existing = (_db.prepare('SELECT COUNT(*) as c FROM goals').get() as any)?.c || 0
  if (existing > 0) return
  try {
    const raw = JSON.parse(readFileSync(goalsPath, 'utf-8'))
    if (!Array.isArray(raw)) return
    _db.exec('BEGIN')
    for (const g of raw) {
      const created = g.created ? new Date(g.created).toISOString() : new Date().toISOString()
      const insertResult = _db.prepare('INSERT INTO goals (title, status, progress, created_at) VALUES (?, ?, ?, ?)').run(g.name || '未命名', 'active', g.progress || 0, created)
      if (g.milestones && Array.isArray(g.milestones)) {
        const goalId = Number(insertResult.lastInsertRowid)
        for (const m of g.milestones) {
          _db.prepare('INSERT INTO key_results (goal_id, title, current_value, target_value, created_at) VALUES (?, ?, ?, 1, ?)').run(goalId, m.text || m, m.done ? 1 : 0, created)
        }
      }
    }
    _db.exec('COMMIT')
    console.log(`[cc-soul][sqlite] migrated goals from JSON`)
  } catch (e: any) {
    try { _db.exec('ROLLBACK') } catch {}
    console.error(`[cc-soul][sqlite] goals migration failed: ${e.message}`)
  }
}

export function migrateRemindersFromJSON() {
  const _db = ensureDb(); if (!_db) return
  if (!existsSync(REMINDERS_PATH)) return
  const existing = (_db.prepare("SELECT COUNT(*) as c FROM reminders WHERE status = 'pending'").get() as any)?.c || 0
  if (existing > 0) return
  try {
    const raw = JSON.parse(readFileSync(REMINDERS_PATH, 'utf-8'))
    if (!Array.isArray(raw) || raw.length === 0) return
    const now = new Date().toISOString()
    _db.exec('BEGIN')
    for (const r of raw) {
      const remindAt = `${r.hour}:${String(r.minute).padStart(2, '0')}`
      _db.prepare("INSERT INTO reminders (chat_id, content, remind_at, repeat_type, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(
        r.userId || '', r.msg, remindAt, r.repeat ? 'daily' : 'once', now
      )
    }
    _db.exec('COMMIT')
    console.log(`[cc-soul][sqlite] migrated ${raw.length} reminders from JSON`)
  } catch (e: any) {
    try { _db.exec('ROLLBACK') } catch {}
    console.error(`[cc-soul][sqlite] reminders migration failed: ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY GRAPH CRUD — uses official entities + relations tables
// ═══════════════════════════════════════════════════════════════════════════════

export function dbGetEntities(): Entity[] {
  if (!ensureDb()) return []
  const rows = db.prepare('SELECT * FROM entities ORDER BY mentions DESC').all() as any[]
  return rows.map(rowToEntity)
}

export function dbAddEntity(name: string, type: string, attrs: string[] = []): void {
  if (!ensureDb() || !name || name.length < 2) return
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  // Upsert: try INSERT first, on conflict update mentions
  const existing = db.prepare('SELECT id, mentions, attrs FROM entities WHERE name = ?').get(name) as any
  if (existing) {
    const oldAttrs: string[] = (() => { try { return JSON.parse(existing.attrs || '[]') } catch { return [] } })()
    for (const a of attrs) { if (!oldAttrs.includes(a)) oldAttrs.push(a) }
    db.prepare('UPDATE entities SET mentions = ?, attrs = ?, invalid_at = NULL WHERE id = ?')
      .run((existing.mentions || 0) + 1, JSON.stringify(oldAttrs), existing.id)
  } else {
    db.prepare(`INSERT INTO entities (name, type, metadata, chat_id, created_at, mentions, firstSeen, attrs, valid_at, invalid_at)
      VALUES (?, ?, '{}', '', ?, 1, ?, ?, ?, NULL)`)
      .run(name, type, nowIso, now, JSON.stringify(attrs), now)
  }
}

export function dbUpdateEntity(name: string, updates: Partial<Entity>): void {
  if (!ensureDb()) return
  const sets: string[] = []
  const values: any[] = []
  if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type) }
  if (updates.mentions !== undefined) { sets.push('mentions = ?'); values.push(updates.mentions) }
  if (updates.attrs !== undefined) { sets.push('attrs = ?'); values.push(JSON.stringify(updates.attrs)) }
  if (updates.valid_at !== undefined) { sets.push('valid_at = ?'); values.push(updates.valid_at) }
  if (updates.invalid_at !== undefined) { sets.push('invalid_at = ?'); values.push(updates.invalid_at) }
  if (updates.firstSeen !== undefined) { sets.push('firstSeen = ?'); values.push(updates.firstSeen) }
  if (sets.length === 0) return
  values.push(name)
  db.prepare(`UPDATE entities SET ${sets.join(', ')} WHERE name = ?`).run(...values)
}

export function dbGetRelations(): Relation[] {
  if (!ensureDb()) return []
  const rows = db.prepare('SELECT * FROM relations ORDER BY ts DESC').all() as any[]
  return rows.map(rowToRelation)
}

export function dbAddRelation(source: string, target: string, type: string): void {
  if (!ensureDb() || !source || !target) return
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  // Check for existing active relation
  const existing = db.prepare(
    'SELECT id FROM relations WHERE src = ? AND dst = ? AND relation = ? AND invalid_at IS NULL'
  ).get(source, target, type) as any
  if (existing) return
  db.prepare(`INSERT INTO relations (src, relation, dst, chat_id, created_at, ts, valid_at, invalid_at)
    VALUES (?, ?, ?, '', ?, ?, ?, NULL)`)
    .run(source, type, target, nowIso, now, now)
}

export function dbGetEntityRelations(entityName: string): Relation[] {
  if (!ensureDb()) return []
  const rows = db.prepare(
    'SELECT * FROM relations WHERE (src = ? OR dst = ?) AND invalid_at IS NULL ORDER BY ts DESC'
  ).all(entityName, entityName) as any[]
  return rows.map(rowToRelation)
}

export function dbInvalidateEntity(name: string): void {
  if (!ensureDb()) return
  const now = Date.now()
  db.prepare('UPDATE entities SET invalid_at = ? WHERE name = ? AND invalid_at IS NULL').run(now, name)
  db.prepare('UPDATE relations SET invalid_at = ? WHERE (src = ? OR dst = ?) AND invalid_at IS NULL').run(now, name, name)
}

export function dbTrimEntities(maxKeep = 400): void {
  if (!ensureDb()) return
  const count = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as any)?.c || 0
  if (count <= 500) return
  // Keep top entities by: valid first, then by mentions desc
  // Delete overflow: invalid first, then lowest mentions
  db.prepare(`DELETE FROM entities WHERE id IN (
    SELECT id FROM entities ORDER BY
      CASE WHEN invalid_at IS NOT NULL THEN 0 ELSE 1 END ASC,
      mentions ASC
    LIMIT ?
  )`).run(count - maxKeep)
}

export function dbTrimRelations(maxKeep = 800): void {
  if (!ensureDb()) return
  const count = (db.prepare('SELECT COUNT(*) as c FROM relations').get() as any)?.c || 0
  if (count <= 1000) return
  db.prepare(`DELETE FROM relations WHERE id IN (
    SELECT id FROM relations ORDER BY
      CASE WHEN invalid_at IS NOT NULL THEN 0 ELSE 1 END ASC,
      ts ASC
    LIMIT ?
  )`).run(count - maxKeep)
}

function rowToEntity(row: any): Entity {
  return {
    name: row.name,
    type: row.type || 'unknown',
    attrs: (() => { try { return JSON.parse(row.attrs || '[]') } catch { return [] } })(),
    firstSeen: row.firstSeen || (row.created_at ? new Date(row.created_at).getTime() : 0),
    mentions: row.mentions || 0,
    valid_at: row.valid_at || 0,
    invalid_at: row.invalid_at ?? null,
  }
}

function rowToRelation(row: any): Relation {
  return {
    source: row.src,
    target: row.dst,
    type: row.relation,
    ts: row.ts || (row.created_at ? new Date(row.created_at).getTime() : 0),
    valid_at: row.valid_at || 0,
    invalid_at: row.invalid_at ?? null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATE graph from JSON
// ═══════════════════════════════════════════════════════════════════════════════

export function migrateGraphFromJSON() {
  if (!ensureDb()) return
  if (!existsSync(GRAPH_PATH)) return
  // Check if cc-soul entity data already exists
  const existing = (db.prepare('SELECT COUNT(*) as c FROM entities WHERE mentions > 0').get() as any)?.c || 0
  if (existing > 0) return
  try {
    const raw = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
    const entities: any[] = raw.entities || []
    const relations: any[] = raw.relations || []
    if (entities.length === 0 && relations.length === 0) return
    console.log(`[cc-soul][sqlite] migrating ${entities.length} entities + ${relations.length} relations from JSON...`)
    db.exec('BEGIN')
    try {
      for (const e of entities) {
        const created = e.firstSeen ? new Date(e.firstSeen).toISOString() : new Date().toISOString()
        db.prepare(`INSERT OR IGNORE INTO entities (name, type, metadata, chat_id, created_at, mentions, firstSeen, attrs, valid_at, invalid_at)
          VALUES (?, ?, '{}', '', ?, ?, ?, ?, ?, ?)`)
          .run(e.name, e.type || 'unknown', created, e.mentions || 0, e.firstSeen || 0,
            JSON.stringify(e.attrs || []), e.valid_at || e.firstSeen || 0, e.invalid_at ?? null)
      }
      for (const r of relations) {
        const created = r.ts ? new Date(r.ts).toISOString() : new Date().toISOString()
        db.prepare(`INSERT OR IGNORE INTO relations (src, relation, dst, chat_id, created_at, ts, valid_at, invalid_at)
          VALUES (?, ?, ?, '', ?, ?, ?, ?)`)
          .run(r.source, r.type, r.target, created, r.ts || 0, r.valid_at || r.ts || 0, r.invalid_at ?? null)
      }
      db.exec('COMMIT')
      console.log(`[cc-soul][sqlite] migrated graph data to SQLite`)
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (e: any) {
    console.error(`[cc-soul][sqlite] graph migration failed: ${e.message}`)
  }
}
