/**
 * decision-log.ts — 决策日志（200 条 ringbuffer，SQLite 存储）
 *
 * 记录每次遗忘/降级/复活/注入/蒸馏淘汰的决策及原因。
 * 不需要仪表盘——出问题时 grep 一下就能定位。
 *
 * cc-soul 原创核心模块 — P0 基座层
 */

interface Decision {
  action: string   // 'graveyard' | 'demote' | 'verify' | 'keep' | 'revive' | 'purge' | 'inject' | 'skip_inject' | 'stale_topic' | 'promote_topic' | 'ab_test'
  key: string      // content.slice(0,30) + '|' + ts  或  topicNode.topic
  reason: string   // 人可读的判定理由，含具体数值
  ts: number
}

// 内存缓存（SQLite 是主存储，内存做读缓存）
let _cache: Decision[] = []
let _cacheLoaded = false

function getDb(): any {
  try {
    const mod = require('./sqlite-store.ts')
    return mod
  } catch {
    return null
  }
}

function ensureCache(): void {
  if (_cacheLoaded) return
  _cacheLoaded = true
  const mod = getDb()
  if (mod?.dbGetDecisions) {
    _cache = mod.dbGetDecisions(undefined, 200)
  }
}

export function logDecision(action: string, key: string, reason: string): void {
  const decision: Decision = { action, key, reason, ts: Date.now() }
  ensureCache()
  _cache.push(decision)
  if (_cache.length > 200) _cache = _cache.slice(-200)

  // 写 SQLite
  const mod = getDb()
  if (mod?.dbLogDecision) {
    mod.dbLogDecision(action, key, reason)
  }
}

export function getDecisions(filter?: string): Decision[] {
  ensureCache()
  if (!filter) return _cache
  return _cache.filter(d =>
    d.action.includes(filter) || d.key.includes(filter) || d.reason.includes(filter)
  )
}

export function dumpDecisions(): string {
  ensureCache()
  return _cache.map(d =>
    `[${new Date(d.ts).toISOString().slice(5, 16)}] ${d.action}: ${d.key} | ${d.reason}`
  ).join('\n')
}

export function getDecisionStats(): { total: number; byAction: Record<string, number> } {
  ensureCache()
  const byAction: Record<string, number> = {}
  for (const d of _cache) {
    byAction[d.action] = (byAction[d.action] || 0) + 1
  }
  return { total: _cache.length, byAction }
}
