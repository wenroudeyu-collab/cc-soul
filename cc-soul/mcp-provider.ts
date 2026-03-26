/**
 * mcp-provider.ts — Expose cc-soul as MCP tool provider
 *
 * Other AI agents can query cc-soul's memory and state via MCP protocol.
 * Tools: cc_memory_search, cc_memory_add, cc_soul_state, cc_persona_info
 */

import { recall, addMemory, memoryState } from './memory.ts'
import { body } from './body.ts'
import { getActivePersona } from './persona.ts'

// #10: Rate limiter for MCP tool handlers
const callCount = new Map<string, number>()
function rateLimit(toolName: string, maxPerMinute = 30): boolean {
  const key = `${toolName}_${Math.floor(Date.now() / 60000)}`
  const count = (callCount.get(key) || 0) + 1
  callCount.set(key, count)
  // Cleanup old keys — remove all entries from expired time windows
  if (callCount.size > 100) {
    const currentWindow = Math.floor(Date.now() / 60000)
    for (const k of callCount.keys()) {
      const windowStr = k.split('_').pop()
      if (windowStr && parseInt(windowStr) < currentWindow) callCount.delete(k)
    }
  }
  return count <= maxPerMinute
}

export interface MCPTool {
  name: string
  description: string
  parameters: Record<string, any>
  handler: (params: any) => any
}

export function getMCPTools(): MCPTool[] {
  return [
    // ── memory_search: override OpenClaw native tool so model calls go through cc-soul recall ──
    {
      name: 'memory_search',
      description: 'Search memories by keyword. Returns relevant memories from cc-soul cognitive memory system.',
      parameters: {
        query: { type: 'string', required: true },
        limit: { type: 'number', default: 5 },
      },
      handler: ({ query, limit = 5 }: { query: string; limit?: number }) => {
        if (!rateLimit('memory_search')) return { results: [], provider: 'cc-soul', citations: 'auto', mode: 'rate-limited' }
        const results = recall(query, Math.min(limit, 20))
        return {
          results: results.map(m => ({
            content: m.content,
            scope: m.scope,
            emotion: m.emotion,
            ts: m.ts,
            confidence: m.confidence ?? 0.7,
          })),
          provider: 'cc-soul',
          citations: 'auto',
          mode: results.length > 0 ? 'cc-soul-recall' : 'no-match',
        }
      },
    },
    {
      name: 'cc_memory_search',
      description: 'Search cc-soul memories by keyword (alias)',
      parameters: {
        query: { type: 'string', required: true },
        limit: { type: 'number', default: 5 },
      },
      handler: ({ query, limit = 5 }: { query: string; limit?: number }) => {
        if (!rateLimit('cc_memory_search')) return { error: 'rate limited' }
        const results = recall(query, limit)
        return results.map(m => ({ content: m.content, scope: m.scope, ts: m.ts }))
      },
    },
    {
      name: 'cc_memory_add',
      description: 'Add a memory to cc-soul',
      parameters: {
        content: { type: 'string', required: true },
        scope: { type: 'string', default: 'fact' },
      },
      handler: ({ content, scope = 'fact' }: { content: string; scope?: string }) => {
        if (!rateLimit('cc_memory_add')) return { error: 'rate limited' }
        addMemory(content, scope)
        return { success: true }
      },
    },
    {
      name: 'cc_soul_state',
      description: 'Get cc-soul current state (energy, mood, memory count)',
      parameters: {},
      handler: () => {
        if (!rateLimit('cc_soul_state')) return { error: 'rate limited' }
        return {
          memoryCount: memoryState.memories.length,
          energy: body.energy,
          mood: body.mood,
          load: body.load,
          persona: getActivePersona()?.name,
        }
      },
    },
    {
      name: 'cc_persona_info',
      description: 'Get cc-soul active persona details',
      parameters: {},
      handler: () => {
        if (!rateLimit('cc_persona_info')) return { error: 'rate limited' }
        const persona = getActivePersona()
        return persona
          ? { name: persona.name, tone: persona.tone, style: persona.style }
          : { name: 'unknown' }
      },
    },
  ]
}
