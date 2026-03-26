import type { SoulModule } from './brain.ts'

/**
 * graph.ts — Entity Graph
 * Entity/relation storage and context query.
 * Storage: SQLite (official entities/relations tables), with in-memory cache for fast query.
 * Note: CLI-powered entity extraction is now handled by runPostResponseAnalysis in cli.ts.
 */

import type { Entity, Relation } from './types.ts'
import { getParam } from './auto-tune.ts'
import {
  dbGetEntities, dbAddEntity, dbUpdateEntity,
  dbGetRelations, dbAddRelation,
  dbInvalidateEntity, dbTrimEntities, dbTrimRelations,
  isSQLiteReady,
} from './sqlite-store.ts'

// Stale threshold now tunable via auto-tune
function getStaleThresholdMs() { return getParam('graph.stale_days') * 24 * 60 * 60 * 1000 }

// ═══════════════════════════════════════════════════════════════════════════════
// Mutable state (in-memory cache, synced from DB)
// ═══════════════════════════════════════════════════════════════════════════════

export const graphState = {
  entities: [] as Entity[],
  relations: [] as Relation[],
}

// ═══════════════════════════════════════════════════════════════════════════════
// Persistence — read/write via SQLite
// ═══════════════════════════════════════════════════════════════════════════════

export function loadGraph() {
  if (!isSQLiteReady()) return
  const entities = dbGetEntities()
  const relations = dbGetRelations()
  graphState.entities.length = 0
  graphState.entities.push(...entities)
  graphState.relations.length = 0
  graphState.relations.push(...relations)
}

/** Reload in-memory cache from DB */
function syncFromDb() {
  if (!isSQLiteReady()) return
  graphState.entities.length = 0
  graphState.entities.push(...dbGetEntities())
  graphState.relations.length = 0
  graphState.relations.push(...dbGetRelations())
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════════

export function addEntity(name: string, type: string, attrs: string[] = []) {
  if (!name || name.length < 2) return
  dbAddEntity(name, type, attrs)
  // Trim if needed
  dbTrimEntities(400)
  // Sync cache
  syncFromDb()
}

export function addRelation(source: string, target: string, type: string) {
  if (!source || !target) return
  dbAddRelation(source, target, type)
  dbTrimRelations(800)
  syncFromDb()
}

// ── Batch add from merged post-response analysis ──
export function addEntitiesFromAnalysis(entities: { name: string; type: string; relation?: string }[]) {
  for (const e of entities) {
    if (e.name && e.name.length >= 2) {
      dbAddEntity(e.name, e.type)
      if (e.relation) dbAddRelation(e.name, '用户', e.relation.slice(0, 30))
    }
  }
  dbTrimEntities(400)
  dbTrimRelations(800)
  syncFromDb()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Invalidation
// ═══════════════════════════════════════════════════════════════════════════════

/** Mark a specific entity (and its relations) as invalid */
export function invalidateEntity(name: string) {
  dbInvalidateEntity(name)
  syncFromDb()
}

/** Mark entities not mentioned in the last 90 days as stale (set invalid_at) */
export function invalidateStaleEntities(): number {
  const now = Date.now()
  let count = 0
  for (const entity of graphState.entities) {
    if (entity.invalid_at !== null) continue
    const lastActivity = Math.max(entity.valid_at || 0, entity.firstSeen || 0)
    if (now - lastActivity > getStaleThresholdMs() && entity.mentions <= 1) {
      dbUpdateEntity(entity.name, { invalid_at: now })
      count++
    }
  }
  if (count > 0) syncFromDb()
  return count
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find entities mentioned in message text (exact name match).
 */
export function findMentionedEntities(msg: string): string[] {
  return graphState.entities
    .filter(e => e.invalid_at === null && e.name.length >= 3 &&
      new RegExp('\\b' + e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(msg))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 5)
    .map(e => e.name)
}

/**
 * From mentioned entities, traverse relations 1-2 hops to find related entity names.
 * Used to expand recall query scope.
 */
export function getRelatedEntities(mentionedEntities: string[], maxHops = 2, maxResults = 10): string[] {
  const visited = new Set<string>(mentionedEntities)
  let frontier = [...mentionedEntities]

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier: string[] = []
    for (const entity of frontier) {
      const neighbors = graphState.relations
        .filter(r => r.invalid_at === null && (r.source === entity || r.target === entity))
        .map(r => r.source === entity ? r.target : r.source)

      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n)
          nextFrontier.push(n)
        }
      }
    }
    frontier = nextFrontier
    if (visited.size >= maxResults + mentionedEntities.length) break
  }

  for (const m of mentionedEntities) visited.delete(m)
  return [...visited].slice(0, maxResults)
}

/**
 * Graph Walk Recall — BFS from startEntity, collect related entities up to maxDepth,
 * then return memory contents that mention any of the walked entities.
 * Accepts memories externally to avoid circular dependency with memory.ts.
 */
export function graphWalkRecall(
  startEntity: string,
  memories: { content: string; scope?: string }[],
  maxDepth = 2,
  maxNodes = 10,
): string[] {
  // BFS to collect entity names
  const visited = new Set<string>([startEntity])
  let frontier = [startEntity]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const entity of frontier) {
      for (const r of graphState.relations) {
        if (r.invalid_at !== null) continue
        const neighbor = r.source === entity ? r.target : r.target === entity ? r.source : null
        if (neighbor && !visited.has(neighbor)) {
          visited.add(neighbor)
          next.push(neighbor)
          if (visited.size >= maxNodes + 1) break
        }
      }
      if (visited.size >= maxNodes + 1) break
    }
    frontier = next
  }
  visited.delete(startEntity) // exclude the start entity itself
  if (visited.size === 0) return []

  // Find memories mentioning walked entities
  const results: string[] = []
  const walkedNames = [...visited]
  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    for (const name of walkedNames) {
      if (mem.content.includes(name)) {
        results.push(mem.content)
        break
      }
    }
    if (results.length >= maxNodes) break
  }
  return results
}

/**
 * Enhanced Graph Walk — BFS with weighted scoring.
 * Returns memory contents ranked by: hop distance (closer=better),
 * relation freshness (newer=better), entity mentions (more=better).
 */
export function graphWalkRecallScored(
  startEntities: string[],
  memories: { content: string; scope?: string }[],
  maxDepth = 2,
  maxResults = 8,
): { content: string; graphScore: number }[] {
  // Weighted BFS: collect entities with distance-based scores
  const entityScores = new Map<string, number>()
  for (const start of startEntities) entityScores.set(start, 1.0)
  let frontier = [...startEntities]

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const hopDecay = 1 / (depth + 2) // hop 0→0.5, hop 1→0.33
    const next: string[] = []
    for (const entity of frontier) {
      for (const r of graphState.relations) {
        if (r.invalid_at !== null) continue
        const neighbor = r.source === entity ? r.target : r.target === entity ? r.source : null
        if (!neighbor || entityScores.has(neighbor)) continue

        // Score: hop decay × relation freshness × entity mentions
        const freshnessMs = Date.now() - (r.valid_at || r.ts || 0)
        const freshness = Math.exp(-freshnessMs / (90 * 86400000)) // 90-day half-life
        const entityNode = graphState.entities.find(e => e.name === neighbor && e.invalid_at === null)
        const mentionBoost = entityNode ? Math.min(2.0, 1 + Math.log2(entityNode.mentions + 1) * 0.3) : 1.0

        const score = hopDecay * freshness * mentionBoost
        entityScores.set(neighbor, score)
        next.push(neighbor)
        if (entityScores.size >= maxResults * 3) break
      }
      if (entityScores.size >= maxResults * 3) break
    }
    frontier = next
  }

  // Remove start entities from results
  for (const s of startEntities) entityScores.delete(s)
  if (entityScores.size === 0) return []

  // Score memories by which walked entities they mention
  const results: { content: string; graphScore: number }[] = []
  for (const mem of memories) {
    if (mem.scope === 'expired' || mem.scope === 'decayed') continue
    let memScore = 0
    for (const [entityName, entityScore] of entityScores) {
      if (mem.content.includes(entityName)) {
        memScore += entityScore
      }
    }
    if (memScore > 0) {
      results.push({ content: mem.content, graphScore: memScore })
    }
  }

  results.sort((a, b) => b.graphScore - a.graphScore)
  return results.slice(0, maxResults)
}

// ═══════════════════════════════════════════════════════════════════════════════
// #1 Knowledge Graph Enhancement
// ═══════════════════════════════════════════════════════════════════════════════

/** Summarize all relations and attributes for a given entity */
export function generateEntitySummary(entityName: string): string | null {
  const entity = graphState.entities.find(e => e.name === entityName && e.invalid_at === null)
  if (!entity) return null
  const rels = graphState.relations
    .filter(r => r.invalid_at === null && (r.source === entityName || r.target === entityName))
    .map(r => r.source === entityName ? `${r.type} → ${r.target}` : `${r.source} ${r.type} →`)
  const parts = [`[${entity.type}] ${entityName} (提及${entity.mentions}次)`]
  if (entity.attrs.length > 0) parts.push(`属性: ${entity.attrs.join(', ')}`)
  if (rels.length > 0) parts.push(`关系: ${rels.slice(0, 8).join('; ')}`)
  return parts.join(' | ')
}

/** BFS to find shortest path between two entities (max 3 hops) */
export function queryGraphPath(from: string, to: string, maxHops = 3): string[] | null {
  if (from === to) return [from]
  const visited = new Map<string, string>([[from, '']])
  let frontier = [from]
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const node of frontier) {
      for (const r of graphState.relations) {
        if (r.invalid_at !== null) continue
        const neighbor = r.source === node ? r.target : r.target === node ? r.source : null
        if (neighbor && !visited.has(neighbor)) {
          visited.set(neighbor, node)
          if (neighbor === to) {
            // Reconstruct path
            const path = [to]
            let cur = to
            let steps = 0
            while (cur !== from && steps < 100) {
              const prev = visited.get(cur)
              if (prev == null) break
              cur = prev
              path.unshift(cur)
              steps++
            }
            return path
          }
          next.push(neighbor)
        }
      }
    }
    frontier = next
  }
  return null
}

export function queryEntityContext(msg: string): string[] {
  const results: string[] = []
  for (const entity of graphState.entities) {
    // Only return active (non-invalidated) entities
    if (entity.invalid_at !== null) continue
    if (msg.includes(entity.name)) {
      // 找这个实体的所有有效关系
      const rels = graphState.relations.filter(r =>
        r.invalid_at === null && (r.source === entity.name || r.target === entity.name),
      )
      if (rels.length > 0) {
        const relStr = rels.map(r => `${r.source} ${r.type} ${r.target}`).join(', ')
        results.push(`[${entity.type}] ${entity.name}: ${relStr}`)
      } else if (entity.attrs.length > 0) {
        results.push(`[${entity.type}] ${entity.name}: ${entity.attrs.join(', ')}`)
      }
    }
  }
  return results.slice(0, 3)
}

export const graphModule: SoulModule = {
  id: 'graph',
  name: '知识图谱',
  priority: 50,
  init() { loadGraph() },
}
