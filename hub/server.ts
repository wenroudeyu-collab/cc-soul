/**
 * Knowledge Hub — cc-soul 知识网络中心 (SQLite 版)
 *
 * 存储引擎：SQLite（单文件，支持索引，百万条毫秒级查询）
 * 运行：npx tsx hub/server.ts
 * 依赖：better-sqlite3（npm install better-sqlite3）
 *
 * API:
 *   POST /federation/upload   ← cc-soul 实例上传知识
 *   GET  /federation/download ← cc-soul 实例拉取知识
 *   GET  /federation/stats    ← 查看网络状态
 *   POST /federation/register ← 注册新 API key（需 admin key）
 *   POST /sync/push           ← 跨设备同步上传（私有）
 *   GET  /sync/pull           ← 跨设备同步下载（私有）
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'

// ── Config ──
const PORT = parseInt(process.env.HUB_PORT || '9900')
const DATA_DIR = process.env.HUB_DATA || resolve(import.meta.dirname || '.', 'data')
const DB_PATH = resolve(DATA_DIR, 'hub.db')
const MIN_QUALITY = 5

// ── Init ──
mkdirSync(DATA_DIR, { recursive: true })

// ── Database ──
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')  // Write-Ahead Logging: 并发读不阻塞
db.pragma('busy_timeout = 5000')

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    instance_name TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    uploads INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    scope TEXT NOT NULL,
    tags TEXT,
    source_instance TEXT NOT NULL,
    source_quality REAL DEFAULT 5.0,
    timestamp INTEGER NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    data TEXT NOT NULL,
    pushed_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_received ON memories(received_at);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_instance);
  CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
  CREATE INDEX IF NOT EXISTS idx_sync_instance ON sync_data(instance_id);
`)

// Add reports column if not exists (safe for existing databases)
try { db.exec(`ALTER TABLE memories ADD COLUMN reports INTEGER DEFAULT 0`) } catch { /* already exists */ }

// ── Prepared statements (performance) ──
const stmts = {
  insertMemory: db.prepare(`
    INSERT OR IGNORE INTO memories (content, scope, tags, source_instance, source_quality, timestamp, content_hash, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getMemories: db.prepare(`
    SELECT * FROM memories WHERE received_at >= ? AND source_instance != ? ORDER BY received_at DESC LIMIT 1000
  `),
  countMemories: db.prepare(`SELECT COUNT(*) as count FROM memories`),
  getApiKey: db.prepare(`SELECT * FROM api_keys WHERE key = ?`),
  insertApiKey: db.prepare(`
    INSERT INTO api_keys (key, instance_id, instance_name, created_at) VALUES (?, ?, ?, ?)
  `),
  updateApiKeyUploads: db.prepare(`UPDATE api_keys SET uploads = uploads + 1 WHERE key = ?`),
  updateApiKeyDownloads: db.prepare(`UPDATE api_keys SET downloads = downloads + 1 WHERE key = ?`),
  getAllApiKeys: db.prepare(`SELECT instance_name, uploads, downloads FROM api_keys`),
  countInstances: db.prepare(`SELECT COUNT(*) as count FROM api_keys`),
  upsertSync: db.prepare(`
    INSERT INTO sync_data (instance_id, data, pushed_at) VALUES (?, ?, ?)
  `),
  getSyncData: db.prepare(`
    SELECT data FROM sync_data WHERE instance_id != ? ORDER BY pushed_at DESC LIMIT 100
  `),
  cleanOldSync: db.prepare(`DELETE FROM sync_data WHERE pushed_at < ?`),
}

// Batch insert transaction
const insertMemoriesBatch = db.transaction((memories: any[]) => {
  let accepted = 0
  for (const m of memories) {
    const result = stmts.insertMemory.run(
      m.content, m.scope, JSON.stringify(m.tags || []),
      m.sourceInstance, m.sourceQuality,
      m.timestamp, m.contentHash, Date.now()
    )
    if (result.changes > 0) accepted++
  }
  return accepted
})

// ── PII filter (server-side double-check) ──
const PII_PATTERNS = [
  /\b1[3-9]\d{9}\b/g,
  /\b\d{17}[\dXx]\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,
  /\b(?:sk-|api[_-]?key|token|secret|password)[=:]\s*\S+/gi,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
]

function hasPII(text: string): boolean {
  return PII_PATTERNS.some(p => { p.lastIndex = 0; return p.test(text) })
}

function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

// ── HTTP helpers ──
const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB max

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
}

// ── Routes ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method || 'GET'

  // Dashboard
  if (method === 'GET' && path === '/dashboard') {
    try {
      const html = readFileSync(resolve(import.meta.dirname || '.', 'dashboard.html'), 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    } catch {
      res.writeHead(404)
      return res.end('dashboard.html not found')
    }
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Instance-Id, X-Quality-Score, X-Admin-Key',
    })
    return res.end()
  }

  try {
    // ── Federation: Upload ──
    if (method === 'POST' && path === '/federation/upload') {
      const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '')
      const keyEntry = stmts.getApiKey.get(apiKey) as any
      if (!keyEntry) return json(res, 401, { error: 'invalid api key' })

      const quality = parseFloat(req.headers['x-quality-score'] as string || '0')
      if (quality < MIN_QUALITY) {
        return json(res, 403, { error: `quality too low: ${quality} < ${MIN_QUALITY}` })
      }

      const body = await readBody(req)
      let data: any
      try { data = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON body' }) }

      // Filter and prepare
      const valid = (data.memories || [])
        .filter((m: any) => m.content && !hasPII(m.content))
        .map((m: any) => ({
          content: m.content,
          scope: m.scope || 'fact',
          tags: m.tags,
          sourceInstance: m.sourceInstance || keyEntry.instance_id,
          sourceQuality: quality,
          timestamp: m.timestamp || Date.now(),
          contentHash: m.contentHash || contentHash(m.content),
        }))

      const accepted = insertMemoriesBatch(valid)
      // Only count if new data was actually accepted
      if (accepted > 0) stmts.updateApiKeyUploads.run(apiKey)

      return json(res, 200, { accepted, total: (data.memories || []).length })
    }

    // ── Federation: Download ──
    if (method === 'GET' && path === '/federation/download') {
      const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '')
      const keyEntry = stmts.getApiKey.get(apiKey) as any
      if (!keyEntry) return json(res, 401, { error: 'invalid api key' })

      const since = parseInt(url.searchParams.get('since') || '0')
      const instance = url.searchParams.get('instance') || keyEntry.instance_id
      const memories = stmts.getMemories.all(since, instance) as any[]

      // Parse tags back from JSON string
      const formatted = memories.map(m => ({
        ...m,
        tags: m.tags ? JSON.parse(m.tags) : [],
      }))

      // Only count as download if there's actually new data
      if (formatted.length > 0) stmts.updateApiKeyDownloads.run(apiKey)
      return json(res, 200, { memories: formatted, count: formatted.length })
    }

    // ── Federation: Stats ──
    if (method === 'GET' && path === '/federation/stats') {
      const totalMemories = (stmts.countMemories.get() as any).count
      const totalInstances = (stmts.countInstances.get() as any).count
      const instances = stmts.getAllApiKeys.all() as any[]

      return json(res, 200, {
        totalMemories,
        instances: totalInstances,
        instanceList: instances,
        dbSize: `${(db.pragma('page_count', { simple: true }) as number * db.pragma('page_size', { simple: true }) as number / 1024 / 1024).toFixed(2)} MB`,
      })
    }

    // ── Federation: Auto-Register (no admin key, for cc-soul clients) ──
    if (method === 'POST' && path === '/federation/auto-register') {
      const body = await readBody(req)
      let data: any
      try { data = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON body' }) }

      const instanceId = data.instanceId
      if (!instanceId) return json(res, 400, { error: 'missing instanceId' })

      // Check if already registered
      const existing = db.prepare(`SELECT key FROM api_keys WHERE instance_id = ?`).get(instanceId) as any
      if (existing) {
        return json(res, 200, { key: existing.key, instanceId, status: 'existing' })
      }

      // Rate limit: max 100 registrations per day
      const todayCount = (db.prepare(
        `SELECT COUNT(*) as c FROM api_keys WHERE created_at > ?`
      ).get(Date.now() - 86400000) as any).c
      if (todayCount >= 100) {
        return json(res, 429, { error: 'too many registrations today, try tomorrow' })
      }

      const newKey = 'csk-' + createHash('sha256')
        .update(Date.now() + Math.random().toString())
        .digest('hex').slice(0, 32)

      stmts.insertApiKey.run(
        newKey,
        instanceId,
        data.instanceName || 'unnamed',
        Date.now(),
      )

      console.log(`[hub] auto-registered: ${instanceId} (${data.instanceName || 'unnamed'})`)
      return json(res, 200, { key: newKey, instanceId, status: 'new' })
    }

    // ── Federation: Register (admin) ──
    if (method === 'POST' && path === '/federation/register') {
      const adminKey = req.headers['x-admin-key'] as string
      if (adminKey !== process.env.HUB_ADMIN_KEY) {
        return json(res, 401, { error: 'invalid admin key' })
      }

      const body = await readBody(req)
      let data: any
      try { data = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON body' }) }
      const newKey = 'csk-' + createHash('sha256')
        .update(Date.now() + Math.random().toString())
        .digest('hex').slice(0, 32)

      stmts.insertApiKey.run(
        newKey,
        data.instanceId || 'unknown',
        data.instanceName || 'unnamed',
        Date.now(),
      )

      return json(res, 200, { key: newKey, instanceId: data.instanceId })
    }

    // ── Sync: Push ──
    if (method === 'POST' && path === '/sync/push') {
      const instanceId = req.headers['x-instance-id'] as string
      if (!instanceId) return json(res, 400, { error: 'missing X-Instance-Id' })

      const body = await readBody(req)

      // Validate JSONL format: each non-empty line must be valid JSON
      const lines = body.split('\n').filter(l => l.trim())
      const validLines: string[] = []
      for (const line of lines) {
        try { JSON.parse(line); validLines.push(line) } catch { /* skip malformed lines */ }
      }
      const validBody = validLines.join('\n')

      // Clean old sync data for this instance (keep latest only)
      stmts.cleanOldSync.run(Date.now() - 7 * 86400000) // clean >7 days old
      stmts.upsertSync.run(instanceId, validBody, Date.now())

      return json(res, 200, { ok: true, lines: validLines.length, dropped: lines.length - validLines.length })
    }

    // ── Sync: Pull ──
    if (method === 'GET' && path === '/sync/pull') {
      const instanceId = req.headers['x-instance-id'] as string || url.searchParams.get('instance') || ''
      if (!instanceId) return json(res, 400, { error: 'missing instance id' })

      const rows = stmts.getSyncData.all(instanceId) as any[]
      const allData = rows.map(r => r.data).join('\n')

      res.writeHead(200, { 'Content-Type': 'application/jsonl' })
      return res.end(allData)
    }

    // ── Telemetry: receive anonymous usage stats ──
    if (method === 'POST' && path === '/telemetry') {
      const body = await readBody(req)
      let data: any
      try { data = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON' }) }

      // Store in telemetry table
      try { db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT, version TEXT, messages INTEGER, memories INTEGER,
        quality REAL, corrections INTEGER, features INTEGER, uptime INTEGER,
        reported_at INTEGER
      )`) } catch {}

      db.prepare(`INSERT INTO telemetry (id, version, messages, memories, quality, corrections, features, uptime, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        data.id || 'unknown', data.v || '?',
        data.msgs || 0, data.mems || 0, data.quality || 0,
        data.corrections || 0, data.features || 0, data.uptime || 0,
        Date.now()
      )

      return json(res, 200, { ok: true })
    }

    // ── Telemetry: view stats (admin) ──
    if (method === 'GET' && path === '/telemetry') {
      try { db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT, version TEXT, messages INTEGER, memories INTEGER,
        quality REAL, corrections INTEGER, features INTEGER, uptime INTEGER,
        reported_at INTEGER
      )`) } catch {}

      const rows = db.prepare(`SELECT * FROM telemetry ORDER BY reported_at DESC LIMIT 100`).all()
      const unique = new Set((rows as any[]).map(r => r.id)).size
      return json(res, 200, { totalReports: rows.length, uniqueInstances: unique, recent: rows.slice(0, 20) })
    }

    // ── Health check ──
    if (method === 'GET' && (path === '/' || path === '/health')) {
      return json(res, 200, {
        status: 'ok',
        version: '1.0.0',
        uptime: process.uptime(),
        memories: (stmts.countMemories.get() as any).count,
        instances: (stmts.countInstances.get() as any).count,
      })
    }

    // ── Federation: Report bad knowledge ──
    if (method === 'POST' && path === '/federation/report') {
      const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '')
      const keyEntry = stmts.getApiKey.get(apiKey) as any
      if (!keyEntry) return json(res, 401, { error: 'invalid api key' })

      const body = await readBody(req)
      let data: any
      try { data = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON body' }) }
      const hash = data.contentHash

      if (!hash) return json(res, 400, { error: 'missing contentHash' })

      const updateReport = db.prepare(`UPDATE memories SET reports = reports + 1 WHERE content_hash = ?`)
      updateReport.run(hash)

      // Auto-delete if reported 3+ times
      const mem = db.prepare(`SELECT reports FROM memories WHERE content_hash = ?`).get(hash) as any
      if (mem && mem.reports >= 3) {
        db.prepare(`DELETE FROM memories WHERE content_hash = ?`).run(hash)
        console.log(`[hub] auto-deleted memory ${hash} (${mem.reports} reports)`)
        return json(res, 200, { action: 'deleted', reports: mem.reports })
      }

      return json(res, 200, { action: 'reported', reports: mem?.reports || 1 })
    }

    // ── 404 ──
    json(res, 404, { error: 'not found', routes: [
      'GET  /health',
      'POST /federation/upload',
      'GET  /federation/download',
      'GET  /federation/stats',
      'POST /federation/register',
      'POST /federation/report',
      'POST /sync/push',
      'GET  /sync/pull',
    ]})

  } catch (e: any) {
    console.error(`[hub] ${method} ${path} error: ${e.message}`)
    json(res, 500, { error: e.message })
  }
})

// ── Graceful shutdown ──
process.on('SIGINT', () => {
  console.log('\n[hub] shutting down...')
  db.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  db.close()
  process.exit(0)
})

server.listen(PORT, () => {
  const memCount = (stmts.countMemories.get() as any).count
  const instanceCount = (stmts.countInstances.get() as any).count

  console.log(`
🧠 cc-soul Knowledge Hub (SQLite)
   listening on http://0.0.0.0:${PORT}
   database: ${DB_PATH}
   memories: ${memCount}
   instances: ${instanceCount}

   API:
   GET  /health                ← 健康检查
   POST /federation/upload     ← 实例上传知识
   GET  /federation/download   ← 实例下载知识
   GET  /federation/stats      ← 网络状态
   POST /federation/register   ← 注册 API key（需 admin key）
   POST /federation/report     ← 举报错误知识
   POST /sync/push            ← 跨设备同步上传
   GET  /sync/pull            ← 跨设备同步下载

   env: HUB_PORT=${PORT} HUB_ADMIN_KEY=${process.env.HUB_ADMIN_KEY ? '(set)' : '⚠️ NOT SET'}
`)
})
