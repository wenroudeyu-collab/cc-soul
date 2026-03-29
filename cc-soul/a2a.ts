/**
 * a2a.ts — Google A2A (Agent-to-Agent) Protocol — Agent Card
 *
 * Exposes cc-soul's capabilities as a standard Agent Card so other agents
 * can discover and invoke cc-soul's features via the A2A protocol.
 *
 * Capabilities: memory-recall, persona-switch, emotion-tracking,
 *               knowledge-graph, quality-eval
 */

import type { SoulModule } from './brain.ts'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'
import { resolve } from 'path'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentCard {
  name: string
  description: string
  capabilities: string[]
  endpoint: string
  version: string
}

export interface A2ARequest {
  capability: string
  params: Record<string, any>
}

export interface A2AResponse {
  status: string
  data: any
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const A2A_LOG_PATH = resolve(DATA_DIR, 'a2a_log.json')

const CAPABILITIES = [
  'memory-recall',
  'persona-switch',
  'emotion-tracking',
  'knowledge-graph',
  'quality-eval',
] as const

type Capability = typeof CAPABILITIES[number]

const CARD: AgentCard = {
  name: 'cc-soul',
  description: 'A self-evolving AI soul engine with memory, persona, emotion tracking, knowledge graph, and quality evaluation capabilities.',
  capabilities: [...CAPABILITIES],
  endpoint: 'local://cc-soul',
  version: '2.1.0',
}

// ═══════════════════════════════════════════════════════════════════════════════
// A2A REQUEST LOG — track incoming requests for diagnostics
// ═══════════════════════════════════════════════════════════════════════════════

interface A2ALogEntry {
  ts: number
  capability: string
  status: string
  durationMs: number
}

let requestLog: A2ALogEntry[] = loadJson<A2ALogEntry[]>(A2A_LOG_PATH, [])

function logRequest(entry: A2ALogEntry) {
  requestLog.push(entry)
  // Keep last 200 entries
  if (requestLog.length > 200) requestLog = requestLog.slice(-200)
  debouncedSave(A2A_LOG_PATH, requestLog)
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT CARD
// ═══════════════════════════════════════════════════════════════════════════════

export function getAgentCard(): AgentCard {
  return { ...CARD }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY HANDLERS — lazy imports to avoid circular dependencies
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMemoryRecall(params: Record<string, any>): Promise<any> {
  const { recall } = await import('./memory.ts')
  const query = params.query ?? params.msg ?? ''
  const topN = params.topN ?? 5
  const userId = params.userId
  const channelId = params.channelId
  const results = recall(query, topN, userId, channelId)
  return results.map(m => ({ content: m.content, scope: m.scope, relevance: m.relevance }))
}

async function handlePersonaSwitch(params: Record<string, any>): Promise<any> {
  const { selectPersona } = await import('./persona.ts')
  const attentionType = params.attentionType ?? 'general'
  const frustration = params.frustration ?? 0
  const userId = params.userId
  const intent = params.intent
  const msg = params.msg
  const persona = selectPersona(attentionType, frustration, userId, intent, msg)
  return { name: persona.name, tone: persona.tone }
}

async function handleEmotionTracking(params: Record<string, any>): Promise<any> {
  const { body } = await import('./body.ts')
  return {
    mood: body.mood,
    energy: body.energy,
    alertness: body.alertness,
    load: body.load,
    anomaly: body.anomaly,
  }
}

async function handleKnowledgeGraph(params: Record<string, any>): Promise<any> {
  const { graphState } = await import('./graph.ts')
  const query = (params.query ?? params.entity ?? '').toLowerCase()
  // Filter entities matching query
  const matchedEntities = graphState.entities
    .filter(e => e.invalid_at === null && e.name.toLowerCase().includes(query))
    .slice(0, params.topN ?? 10)
    .map(e => ({ name: e.name, type: e.type, attrs: e.attrs, mentions: e.mentions }))
  // Find relations involving matched entities
  const entityNames = new Set(matchedEntities.map(e => e.name))
  const matchedRelations = graphState.relations
    .filter(r => r.invalid_at === null && (entityNames.has(r.source) || entityNames.has(r.target)))
    .slice(0, 20)
    .map(r => ({ source: r.source, target: r.target, type: r.type }))
  return { entities: matchedEntities, relations: matchedRelations }
}

async function handleQualityEval(params: Record<string, any>): Promise<any> {
  const { evalMetrics } = await import('./quality.ts')
  return {
    totalResponses: evalMetrics.totalResponses,
    avgQuality: evalMetrics.avgQuality,
    correctionRate: evalMetrics.correctionRate,
    brainHitRate: evalMetrics.brainHitRate,
    memoryRecallRate: evalMetrics.memoryRecallRate,
    lastEval: evalMetrics.lastEval,
  }
}

const HANDLERS: Record<Capability, (params: Record<string, any>) => Promise<any>> = {
  'memory-recall': handleMemoryRecall,
  'persona-switch': handlePersonaSwitch,
  'emotion-tracking': handleEmotionTracking,
  'knowledge-graph': handleKnowledgeGraph,
  'quality-eval': handleQualityEval,
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

export async function handleA2ARequest(request: A2ARequest): Promise<A2AResponse> {
  const start = Date.now()
  const { capability, params } = request

  if (!CAPABILITIES.includes(capability as Capability)) {
    const entry: A2ALogEntry = { ts: start, capability, status: 'error:unknown_capability', durationMs: 0 }
    logRequest(entry)
    return {
      status: 'error',
      data: {
        message: `Unknown capability: ${capability}`,
        available: [...CAPABILITIES],
      },
    }
  }

  try {
    const handler = HANDLERS[capability as Capability]
    if (!handler) {
      return { status: 'error', data: { message: `No handler for capability: ${capability}` } }
    }
    const data = await handler(params ?? {})
    const durationMs = Date.now() - start
    logRequest({ ts: start, capability, status: 'ok', durationMs })
    return { status: 'ok', data }
  } catch (e: any) {
    const durationMs = Date.now() - start
    logRequest({ ts: start, capability, status: `error:${e.message}`, durationMs })
    console.error(`[cc-soul][a2a] handler error for ${capability}: ${e.message}`)
    return {
      status: 'error',
      data: { message: e.message },
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export const a2aModule: SoulModule = {
  id: 'a2a',
  name: 'A2A 协议 (Agent Card)',
  features: ['a2a'],
  dependencies: [],
  priority: 30,
  enabled: true,

  init() {
    requestLog = loadJson<A2ALogEntry[]>(A2A_LOG_PATH, [])
    console.log(`[cc-soul][a2a] Agent Card ready — ${CAPABILITIES.length} capabilities exposed`)
  },
}
