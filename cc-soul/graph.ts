import type { SoulModule } from './brain.ts'

/**
 * graph.ts — Entity Graph
 * Entity/relation storage and context query.
 * Storage: SQLite (official entities/relations tables), with in-memory cache for fast query.
 * Note: CLI-powered entity extraction is now handled by runPostResponseAnalysis in cli.ts.
 */

import type { Entity, Relation } from './types.ts'
import { getParam } from './auto-tune.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'
import {
  dbGetEntities, dbAddEntity, dbUpdateEntity,
  dbGetRelations, dbAddRelation,
  dbInvalidateEntity, dbTrimEntities, dbTrimRelations,
  dbInvalidateStaleRelations,
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
  ranks: new Map<string, number>(),
}

// ── Inverted index: entity name → Set of memory indices that mention it ──
// Populated by graphWalkRecallScored on first call, then updated incrementally.
let _entityToMemIdx: Map<string, Set<number>> | null = null
let _indexedMemCount = 0

/** Build or incrementally update the inverted index for entity→memory mapping */
function ensureEntityMemoryIndex(memories: { content: string; scope?: string }[]): Map<string, Set<number>> {
  const entityNames = graphState.entities
    .filter(e => e.invalid_at === null && e.name.length >= 2)
    .map(e => e.name)

  if (!_entityToMemIdx) {
    // Full rebuild
    _entityToMemIdx = new Map()
    for (const name of entityNames) _entityToMemIdx.set(name, new Set())
    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i]
      if (mem.scope === 'expired' || mem.scope === 'decayed') continue
      for (const name of entityNames) {
        if (mem.content.includes(name)) {
          _entityToMemIdx.get(name)!.add(i)
        }
      }
    }
    _indexedMemCount = memories.length
  } else if (memories.length > _indexedMemCount) {
    // Incremental: only scan new memories
    for (let i = _indexedMemCount; i < memories.length; i++) {
      const mem = memories[i]
      if (mem.scope === 'expired' || mem.scope === 'decayed') continue
      for (const name of entityNames) {
        if (mem.content.includes(name)) {
          if (!_entityToMemIdx.has(name)) _entityToMemIdx.set(name, new Set())
          _entityToMemIdx.get(name)!.add(i)
        }
      }
    }
    // Ensure new entities have entries
    for (const name of entityNames) {
      if (!_entityToMemIdx.has(name)) {
        const s = new Set<number>()
        for (let i = 0; i < memories.length; i++) {
          const mem = memories[i]
          if (mem.scope !== 'expired' && mem.scope !== 'decayed' && mem.content.includes(name)) s.add(i)
        }
        _entityToMemIdx.set(name, s)
      }
    }
    _indexedMemCount = memories.length
  }
  return _entityToMemIdx
}

/** Invalidate inverted index (call when entities change) */
function invalidateEntityMemoryIndex() { _entityToMemIdx = null; _indexedMemCount = 0 }

// ── PageRank dirty flag ──
let _pageRankDirty = true

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
  dbTrimEntities(800)
  // Sync cache
  syncFromDb()
  _pageRankDirty = true
  invalidateEntityMemoryIndex()
}

export function addRelation(source: string, target: string, type: string) {
  if (!source || !target) return
  dbAddRelation(source, target, type)
  dbTrimRelations(800)
  syncFromDb()
  _pageRankDirty = true
}

// ── Batch add from merged post-response analysis ──
export function addEntitiesFromAnalysis(entities: { name: string; type: string; relation?: string }[]) {
  for (const e of entities) {
    if (e.name && e.name.length >= 2) {
      dbAddEntity(e.name, e.type)
      if (e.relation) dbAddRelation(e.name, '用户', e.relation.slice(0, 30))
    }
  }
  dbTrimEntities(800)
  dbTrimRelations(800)
  syncFromDb()
  _pageRankDirty = true
  invalidateEntityMemoryIndex()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Invalidation
// ═══════════════════════════════════════════════════════════════════════════════

/** Mark a specific entity (and its relations) as invalid */
export function invalidateEntity(name: string) {
  dbInvalidateEntity(name)
  syncFromDb()
  _pageRankDirty = true
  invalidateEntityMemoryIndex()
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

/** Mark relations not activated in the last 90 days as stale (set invalid_at) */
export function invalidateStaleRelations(): number {
  const now = Date.now()
  const thresholdMs = getStaleThresholdMs()
  let count = 0
  for (const r of graphState.relations) {
    if (r.invalid_at !== null) continue
    const lastActivity = Math.max(r.valid_at || 0, r.ts || 0)
    if (now - lastActivity > thresholdMs) {
      r.invalid_at = now
      count++
    }
  }
  if (count > 0) {
    // Persist via bulk DB update
    if (isSQLiteReady()) {
      dbInvalidateStaleRelations(thresholdMs)
    }
    _pageRankDirty = true
  }
  return count
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find entities mentioned in message text (exact name match).
 */
export function findMentionedEntities(msg: string): string[] {
  const mentioned = graphState.entities
    .filter(e => e.invalid_at === null && e.name.length >= 3 &&
      new RegExp('(?:^|[^a-zA-Z\\u4e00-\\u9fff])' + e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-zA-Z\\u4e00-\\u9fff]|$)', 'i').test(msg))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 5)

  // ── Spreading activation: boost mentioned entities + propagate to neighbors ──
  for (const e of mentioned) {
    e.activation = Math.min(1.0, (e.activation ?? 0) + 0.3)
    e.lastActivatedAt = Date.now()
    // Propagate to 1-hop neighbors with decay
    for (const r of graphState.relations) {
      if (r.invalid_at !== null) continue
      const neighbor = r.source === e.name ? r.target : r.target === e.name ? r.source : null
      if (!neighbor) continue
      const ne = graphState.entities.find(n => n.name === neighbor && n.invalid_at === null)
      if (ne) {
        ne.activation = Math.min(1.0, (ne.activation ?? 0) + 0.1)
        ne.lastActivatedAt = Date.now()
      }
    }
  }

  return mentioned.map(e => e.name)
}

/** Decay all entity activations. Called from heartbeat. */
export function decayActivations(factor = 0.92) {
  for (const e of graphState.entities) {
    if (e.activation && e.activation > 0.01) {
      e.activation *= factor
      if (e.activation < 0.01) e.activation = 0
    }
  }
}

// ── Relation type weights for BFS traversal ──
const RELATION_WEIGHTS: Record<string, number> = {
  caused_by: 1.5, depends_on: 1.3, contradicts: 0.5,
  uses: 1.0, works_at: 1.0, knows: 0.8, part_of: 0.9,
  related_to: 0.7, follows: 0.6,
  prefers_over: 1.1, triggers: 1.2, learned_from: 1.3,
}

/**
 * From mentioned entities, traverse relations 1-2 hops to find related entity names.
 * Weighted by relation type — higher-weight relations are explored first.
 */
export function getRelatedEntities(mentionedEntities: string[], maxHops = 2, maxResults = 10): string[] {
  const visited = new Set<string>(mentionedEntities)
  let frontier = [...mentionedEntities]

  for (let hop = 0; hop < maxHops; hop++) {
    const candidates: { name: string; weight: number }[] = []
    for (const entity of frontier) {
      for (const r of graphState.relations) {
        if (r.invalid_at !== null) continue
        const neighbor = r.source === entity ? r.target : r.target === entity ? r.source : null
        if (!neighbor || visited.has(neighbor)) continue
        const relWeight = (r.weight ?? 1.0) * (RELATION_WEIGHTS[r.type] ?? 0.8)
        candidates.push({ name: neighbor, weight: relWeight })
      }
    }
    // Sort by weight descending — explore high-value relations first
    candidates.sort((a, b) => b.weight - a.weight)
    const nextFrontier: string[] = []
    for (const c of candidates) {
      if (visited.has(c.name)) continue
      visited.add(c.name)
      nextFrontier.push(c.name)
      if (visited.size >= maxResults + mentionedEntities.length) break
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
// ═══════════════════════════════════════════════════════════════════════════════
// Personalized PageRank — query-biased ranking instead of global PageRank
// Seeds teleport back to query-relevant entities, so nearby nodes get higher rank.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Personalized PageRank with seed entities as teleport targets.
 * α = teleport probability (back to seeds), 1-α = walk along edges.
 */
export function personalizedPageRank(seeds: string[], alpha = 0.15, maxIter = 20): Map<string, number> {
  if (seeds.length === 0) return new Map()

  const activeEntities = new Set(
    graphState.entities.filter(e => e.invalid_at === null).map(e => e.name)
  )
  // Only use seeds that exist in the graph
  const validSeeds = seeds.filter(s => activeEntities.has(s))
  if (validSeeds.length === 0) return new Map()

  const ranks = new Map<string, number>()
  // Initialize: seeds get equal rank, others get 0
  for (const s of validSeeds) ranks.set(s, 1 / validSeeds.length)

  // Build adjacency: outDegree per node
  const outEdges = new Map<string, { target: string; weight: number }[]>()
  for (const name of activeEntities) outEdges.set(name, [])
  for (const r of graphState.relations) {
    if (r.invalid_at !== null) continue
    if (!activeEntities.has(r.source) || !activeEntities.has(r.target)) continue
    const relTypeWeight = RELATION_WEIGHTS[r.type] ?? 0.8
    const w = (r.weight ?? 1.0) * (r.confidence ?? 0.7) * relTypeWeight
    outEdges.get(r.source)!.push({ target: r.target, weight: w })
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const newRanks = new Map<string, number>()
    // Teleport component: α probability → return to seed nodes
    for (const s of validSeeds) newRanks.set(s, alpha / validSeeds.length)

    // Walk component: (1-α) probability → propagate along edges
    for (const [node, rank] of ranks) {
      const edges = outEdges.get(node)
      if (!edges || edges.length === 0) continue
      const totalWeight = edges.reduce((s, e) => s + e.weight, 0)
      if (totalWeight <= 0) continue
      for (const e of edges) {
        const share = (1 - alpha) * rank * (e.weight / totalWeight)
        newRanks.set(e.target, (newRanks.get(e.target) || 0) + share)
      }
    }

    // Copy new ranks
    ranks.clear()
    for (const [k, v] of newRanks) ranks.set(k, v)
  }

  return ranks
}

// ═══════════════════════════════════════════════════════════════════════════════
// Spreading Activation — replaces PPR as default graph scoring in graphWalkRecallScored
// Iteratively propagates activation from seed entities along weighted edges.
// ═══════════════════════════════════════════════════════════════════════════════

export function spreadingActivation(
  seeds: string[],
  graphStateRef: { relations: Relation[] },
  maxIter = 3,
  decayFactor = 0.5
): Map<string, number> {
  const activation = new Map<string, number>()
  // 初始激活
  for (const s of seeds) activation.set(s, 1.0)

  for (let iter = 0; iter < maxIter; iter++) {
    const newActivation = new Map<string, number>()
    for (const [node, act] of activation) {
      if (act < 0.01) continue  // prune negligible activations
      // 沿出边传播
      const edges = graphStateRef.relations.filter(r =>
        (r.source === node || r.target === node) && !r.invalid_at
      )
      for (const e of edges) {
        const neighbor = e.source === node ? e.target : e.source
        const edgeWeight = (e.weight || 1) * (RELATION_WEIGHTS[e.type] || 0.7)
        const spread = act * decayFactor * edgeWeight
        newActivation.set(neighbor, (newActivation.get(neighbor) || 0) + spread)
      }
    }
    // 合并到主激活图
    for (const [k, v] of newActivation) {
      activation.set(k, (activation.get(k) || 0) + v)
    }
  }
  return activation
}

export function graphWalkRecallScored(
  startEntities: string[],
  memories: { content: string; scope?: string }[],
  maxDepth = 2,
  maxResults = 8,
): { content: string; graphScore: number }[] {
  // ── Spreading Activation: replaces PPR for query-biased entity scoring ──
  const saRanks = spreadingActivation(startEntities, graphState, 3, 0.5)

  // Weighted BFS for depth-limited exploration, blended with spreading activation
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

        // Score: hop decay × relation freshness × entity mentions × relation type weight
        const freshnessMs = Date.now() - (r.valid_at || r.ts || 0)
        const freshness = Math.exp(-freshnessMs / (90 * 86400000)) // 90-day half-life
        const entityNode = graphState.entities.find(e => e.name === neighbor && e.invalid_at === null)
        const mentionBoost = entityNode ? Math.min(2.0, 1 + Math.log2(entityNode.mentions + 1) * 0.3) : 1.0
        // Activation boost: recently mentioned entities score higher
        const activationBoost = entityNode?.activation ? (1.0 + entityNode.activation * 0.5) : 1.0
        // Relation type weight + stored weight/confidence
        const relTypeWeight = RELATION_WEIGHTS[r.type] ?? 0.8
        const relWeight = (r.weight ?? 1.0) * (r.confidence ?? 0.7) * relTypeWeight

        const bfsScore = hopDecay * freshness * mentionBoost * activationBoost * relWeight
        // Spreading Activation contribution: blend BFS score with SA ranks
        const saScore = saRanks.get(neighbor) ?? 0
        const combinedScore = bfsScore * 0.5 + saScore * 0.5  // SA already in comparable range
        entityScores.set(neighbor, combinedScore)
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

  // Score memories using inverted index (O(walked_entities × avg_matches) instead of O(memories × entities))
  const idx = ensureEntityMemoryIndex(memories)
  const memScoreMap = new Map<number, number>()
  for (const [entityName, entityScore] of entityScores) {
    const memIndices = idx.get(entityName)
    if (!memIndices) continue
    for (const i of memIndices) {
      memScoreMap.set(i, (memScoreMap.get(i) || 0) + entityScore)
    }
  }

  const results: { content: string; graphScore: number }[] = []
  for (const [i, score] of memScoreMap) {
    if (i < memories.length) {
      results.push({ content: memories[i].content, graphScore: score })
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
  // Find mentioned entities for personalized PageRank seeding
  const mentionedNames: string[] = []
  const results: { text: string; rank: number }[] = []
  for (const entity of graphState.entities) {
    if (entity.invalid_at !== null) continue
    if (msg.includes(entity.name)) mentionedNames.push(entity.name)
  }

  // Use Spreading Activation with mentioned entities as seeds (query-biased)
  const pprRanks = mentionedNames.length > 0
    ? spreadingActivation(mentionedNames, graphState, 3, 0.5)
    : graphState.ranks  // fallback to global PageRank if no entities mentioned

  for (const entity of graphState.entities) {
    if (entity.invalid_at !== null) continue
    if (!msg.includes(entity.name)) continue
    const rels = graphState.relations.filter(r =>
      r.invalid_at === null && (r.source === entity.name || r.target === entity.name),
    )
    const rank = pprRanks.get(entity.name) || 0
    if (rels.length > 0) {
      const relStr = rels.map(r => `${r.source} ${r.type} ${r.target}`).join(', ')
      results.push({ text: `[${entity.type}] ${entity.name}: ${relStr}`, rank })
    } else if (entity.attrs.length > 0) {
      results.push({ text: `[${entity.type}] ${entity.name}: ${entity.attrs.join(', ')}`, rank })
    }
  }
  // Sort by personalized PageRank descending
  results.sort((a, b) => b.rank - a.rank)
  return results.slice(0, 3).map(r => r.text)
}

// ═══════════════════════════════════════════════════════════════════════════════
// #5 PageRank — importance ranking for knowledge graph nodes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simplified PageRank with mention-based boost.
 * Called from heartbeat to periodically recompute node importance.
 * Skips recomputation if graph hasn't changed since last run (dirty flag).
 */
export function computePageRank(iterations = 3, dampingFactor = 0.85): void {
  if (!_pageRankDirty && graphState.ranks.size > 0) return
  const activeEntities = graphState.entities.filter(e => e.invalid_at === null)
  const N = activeEntities.length
  if (N === 0) { graphState.ranks.clear(); return }

  const names = new Set(activeEntities.map(e => e.name))
  const ranks = new Map<string, number>()

  // Initial rank = 1/N
  for (const name of names) ranks.set(name, 1 / N)

  // Build adjacency: outDegree per node and neighbor lists
  const outDegree = new Map<string, number>()
  const inEdges = new Map<string, string[]>() // node -> list of neighbors pointing to it
  for (const name of names) { outDegree.set(name, 0); inEdges.set(name, []) }

  for (const r of graphState.relations) {
    if (r.invalid_at !== null) continue
    if (!names.has(r.source) || !names.has(r.target)) continue
    // Directed graph: source → target only
    outDegree.set(r.source, (outDegree.get(r.source) || 0) + 1)
    inEdges.get(r.target)!.push(r.source)
  }

  // Iterative PageRank
  for (let iter = 0; iter < iterations; iter++) {
    const newRanks = new Map<string, number>()
    for (const name of names) {
      let sum = 0
      const neighbors = inEdges.get(name) || []
      for (const neighbor of neighbors) {
        const neighborOut = outDegree.get(neighbor) || 1
        sum += (ranks.get(neighbor) || 0) / neighborOut
      }
      newRanks.set(name, (1 - dampingFactor) / N + dampingFactor * sum)
    }
    // Apply time-decayed mention boost: recent mentions matter more
    const now = Date.now()
    for (const entity of activeEntities) {
      const base = newRanks.get(entity.name) || 0
      // Time decay: use lastActivatedAt or firstSeen as reference
      const refTs = entity.lastActivatedAt || entity.firstSeen || entity.valid_at || now
      const ageDays = Math.max(0, (now - refTs) / 86400000)
      const timeDecayedMentions = entity.mentions * Math.exp(-ageDays / 30)
      const mentionBoost = 1 + Math.log1p(timeDecayedMentions) * 0.2
      newRanks.set(entity.name, base * mentionBoost)
    }
    // Copy to ranks for next iteration
    for (const [k, v] of newRanks) ranks.set(k, v)
  }

  graphState.ranks = ranks
  _pageRankDirty = false
  console.log(`[cc-soul][graph] PageRank computed for ${N} entities`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Social Graph — 关系图谱：追踪用户提到的人物及情绪关联
// (merged from social-graph.ts)
// ═══════════════════════════════════════════════════════════════════════════════

const SOCIAL_PATH = resolve(DATA_DIR, 'social_graph.json')

interface SocialStyle { tone: string; typical_mood: string }

interface SocialNode {
  name: string
  mentions: number
  lastMentioned: number
  emotionSum: number  // positive = good vibes, negative = stress
  emotions: { positive: number; negative: number; neutral: number }  // categorized emotion counts
  recentTopics: string[]
  style?: SocialStyle
}

let socialGraph: SocialNode[] = loadJson<SocialNode[]>(SOCIAL_PATH, [])

const ROLE_PATTERNS = /老板|领导|boss|同事|colleague|朋友|女朋友|男朋友|老婆|老公|爸|妈|哥|姐|弟|妹|老师|客户/g

export function detectMentionedPeople(msg: string): string[] {
  const roles = msg.match(ROLE_PATTERNS) || []
  // Also detect names like 小李, 小王, etc
  const names = msg.match(/[小大老][A-Z\u4e00-\u9fff]/g) || []
  return [...new Set([...roles, ...names])]
}

export function updateSocialGraph(msg: string, mood: number) {
  const people = detectMentionedPeople(msg)
  for (const name of people) {
    let node = socialGraph.find(n => n.name === name)
    if (!node) {
      node = { name, mentions: 0, lastMentioned: 0, emotionSum: 0, emotions: { positive: 0, negative: 0, neutral: 0 }, recentTopics: [] }
      socialGraph.push(node)
    }
    node.mentions++
    node.lastMentioned = Date.now()
    node.emotionSum += mood
    if (!node.emotions) node.emotions = { positive: 0, negative: 0, neutral: 0 }
    if (mood > 0.2) node.emotions.positive++
    else if (mood < -0.2) node.emotions.negative++
    else node.emotions.neutral++
    // Detect communication style: formal vs casual
    const formalRe = /请问|您|汇报|报告|会议|安排|deadline|项目|审批|review|领导|老板|boss|客户/i
    const casualRe = /哈哈|lol|hhh|😂|🤣|卧槽|牛逼|nb|6{2,}|awsl|yyds|绝了|离谱|xswl|兄弟|哥们|姐妹|朋友/i
    const isFormal = formalRe.test(msg)
    const isCasual = casualRe.test(msg)
    const detectedTone = isFormal && !isCasual ? 'formal' : isCasual && !isFormal ? 'casual' : 'mixed'
    const moodLabel = mood > 0.2 ? '放松' : mood < -0.2 ? '焦虑' : '平稳'
    if (!node.style) node.style = { tone: detectedTone, typical_mood: moodLabel }
    else {
      // Blend: only update if consistent signal (avoid flip-flopping)
      if (detectedTone !== 'mixed') node.style.tone = detectedTone
      node.style.typical_mood = moodLabel
    }
    // Extract topic keyword
    const topic = msg.replace(new RegExp(name, 'g'), '').match(/[\u4e00-\u9fff]{2,4}/)?.[0]
    if (topic && !node.recentTopics.includes(topic)) {
      node.recentTopics.push(topic)
      if (node.recentTopics.length > 5) node.recentTopics.shift()
    }
  }
  if (people.length > 0) debouncedSave(SOCIAL_PATH, socialGraph)
}

export function getSocialContext(msg: string): string | null {
  const people = detectMentionedPeople(msg)
  if (people.length === 0) return null
  const hints: string[] = []
  for (const name of people) {
    const node = socialGraph.find(n => n.name === name)
    if (!node || node.mentions < 2) continue
    const emotions = node.emotions || { positive: 0, negative: 0, neutral: 0 }
    const total = emotions.positive + emotions.negative + emotions.neutral
    const emotionLabel = total < 2 ? '数据不足'
      : emotions.negative > emotions.positive * 2 ? '明显焦虑/压力'
      : emotions.positive > emotions.negative * 2 ? '积极/开心'
      : '混合情绪'
    const styleHint = node.style
      ? `，语境${node.style.tone === 'formal' ? '正式' : node.style.tone === 'casual' ? '轻松' : '混合'}/${node.style.typical_mood}`
      : ''
    hints.push(`${name}：提到${node.mentions}次，情绪倾向${emotionLabel}${styleHint}`)
  }
  if (hints.length === 0) return null
  // Build style-aware guidance
  const styleGuides: string[] = []
  for (const name of people) {
    const node = socialGraph.find(n => n.name === name)
    if (!node?.style || node.mentions < 2) continue
    const { tone, typical_mood } = node.style
    if (tone === 'formal' || typical_mood === '焦虑')
      styleGuides.push(`[社交语境] 用户提到${name}时通常比较${typical_mood}，回复要更稳重`)
    else if (tone === 'casual')
      styleGuides.push(`[社交语境] 用户提到${name}时比较放松，回复可以轻松一些`)
  }
  const base = `[关系图谱] ${hints.join('；')}`
  return styleGuides.length > 0 ? `${base}\n${styleGuides.join('\n')}` : `${base}。回复时参考情绪背景`
}

/** Reset graph state (for testing) */
export function _resetSocialGraph() { socialGraph.length = 0 }

// ═══════════════════════════════════════════════════════════════════════════════
// Causal Chain — 沿 caused_by 方向做有向 BFS，返回因果链上的实体
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Trace causal chain from given entities along caused_by/triggers/depends_on edges.
 * Returns chain of entity names with direction arrows for augment display.
 */
export function traceCausalChain(startEntities: string[], maxHops = 3): string[] {
  const CAUSAL_TYPES = new Set(['caused_by', 'triggers', 'depends_on', 'learned_from'])
  const chains: string[] = []

  for (const start of startEntities.slice(0, 3)) {
    const visited = new Set<string>([start])
    const path = [start]
    let current = start

    for (let hop = 0; hop < maxHops; hop++) {
      let best: { target: string; type: string; ts: number } | null = null
      for (const r of graphState.relations) {
        if (r.invalid_at !== null) continue
        if (!CAUSAL_TYPES.has(r.type)) continue
        // Follow source→target direction for causal edges
        if (r.source === current && !visited.has(r.target)) {
          if (!best || r.ts > best.ts) best = { target: r.target, type: r.type, ts: r.ts }
        }
      }
      if (!best) break
      visited.add(best.target)
      path.push(`-[${best.type}]→`, best.target)
      current = best.target
    }

    if (path.length > 1) chains.push(path.join(' '))
  }

  return chains
}

export const graphModule: SoulModule = {
  id: 'graph',
  name: '知识图谱',
  priority: 50,
  init() { loadGraph() },
}
