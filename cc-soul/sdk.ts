/**
 * sdk.ts — cc-soul Lightweight SDK
 *
 * Zero-dependency SDK for integrating cc-soul into any TypeScript/JavaScript project.
 * Uses only native fetch. Three lines to get started:
 *
 *   import { CCSoul } from 'cc-soul/sdk'
 *   const soul = new CCSoul('http://localhost:18800')
 *   const ctx = await soul.process('你好', 'user123')
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Cognition analysis result */
export interface CogResult {
  attention: string   // general | correction | question | emotional | technical
  intent: string      // wants_answer | wants_opinion | wants_action
  strategy: string    // balanced | precise | creative
  complexity: number  // 0-1
}

/** A single augment injected into context */
export interface AugmentItem {
  content: string
  priority: number
  tokens: number
}

/** A recalled memory */
export interface MemoryItem {
  content: string
  scope: string
  emotion?: string
}

/** Result of process() */
export interface ProcessResult {
  /** Full system prompt — inject into your LLM's system message */
  systemPrompt: string
  /** Augmented context (merged string) */
  augments: string
  /** Augments as structured array */
  augmentsArray: AugmentItem[]
  /** Recalled memories relevant to this message */
  memories: MemoryItem[]
  /** Current mood score (-1 to 1) */
  mood: number
  /** Current energy (0-1) */
  energy: number
  /** Emotion label: positive | negative | neutral */
  emotion: string
  /** Cognition analysis (null if unavailable) */
  cognition: CogResult | null
}

/** Result of feedback() */
export interface FeedbackResult {
  learned: boolean
}

/** User profile snapshot */
export interface ProfileResult {
  avatar: Record<string, any>
  social: { name: string; relation: string; samples: number }[]
  identity: string
  thinkingStyle: string
  values: string[]
  vocabulary: Record<string, number>
  mood: number
  energy: number
}

/** Feature flag entry */
export interface FeatureEntry {
  [key: string]: boolean
}

/** Health check result */
export interface HealthResult {
  status: string
  port: number
  version: string
}

/** Options for process() */
export interface ProcessOptions {
  /** Custom system prompt to prepend */
  systemPrompt?: string
}

/** Time range for recallByTime */
export interface TimeRange {
  from: number   // unix timestamp (ms)
  to?: number    // unix timestamp (ms), defaults to now
}

/** Options for recallByTime */
export interface RecallOptions {
  scope?: string
  limit?: number
}

/** SDK error thrown on fetch failure or API error */
export class CCSoulError extends Error {
  status: number
  body: any
  constructor(message: string, status: number, body?: any) {
    super(message)
    this.name = 'CCSoulError'
    this.status = status
    this.body = body
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SDK CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class CCSoul {
  private baseUrl: string
  private timeout: number

  /**
   * Create a cc-soul SDK instance.
   * @param baseUrl - Soul API base URL (default: http://localhost:18800)
   * @param timeout - Request timeout in ms (default: 30000)
   */
  constructor(baseUrl = 'http://localhost:18800', timeout = 30000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeout = timeout
  }

  // ── Internal fetch wrapper ──

  private async _post<T>(path: string, body: Record<string, any>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await resp.json() as any
      if (!resp.ok || data?.error) {
        throw new CCSoulError(
          data?.error || `HTTP ${resp.status}`,
          resp.status,
          data,
        )
      }
      return data as T
    } catch (e: any) {
      if (e instanceof CCSoulError) throw e
      if (e.name === 'AbortError') throw new CCSoulError(`Request timeout (${this.timeout}ms)`, 0)
      throw new CCSoulError(e.message || 'fetch failed', 0)
    } finally {
      clearTimeout(timer)
    }
  }

  private async _get<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
      })
      const data = await resp.json() as any
      if (!resp.ok || data?.error) {
        throw new CCSoulError(
          data?.error || `HTTP ${resp.status}`,
          resp.status,
          data,
        )
      }
      return data as T
    } catch (e: any) {
      if (e instanceof CCSoulError) throw e
      if (e.name === 'AbortError') throw new CCSoulError(`Request timeout (${this.timeout}ms)`, 0)
      throw new CCSoulError(e.message || 'fetch failed', 0)
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Public API ──

  /**
   * Process a user message through the soul engine.
   * Returns enriched context (system prompt, augments, memories, emotion state).
   */
  async process(message: string, userId: string, options?: ProcessOptions & { agentId?: string }): Promise<ProcessResult> {
    const raw = await this._post<any>('/process', {
      message,
      user_id: userId,
      ...(options?.agentId ? { agent_id: options.agentId } : {}),
      ...(options?.systemPrompt ? { system_prompt: options.systemPrompt } : {}),
    })
    return {
      systemPrompt: raw.system_prompt || '',
      augments: raw.augments || '',
      augmentsArray: raw.augments_array || [],
      memories: raw.memories || [],
      mood: raw.mood ?? 0,
      energy: raw.energy ?? 1,
      emotion: raw.emotion || 'neutral',
      cognition: raw.cognition || null,
    }
  }

  /**
   * Send feedback (user message + AI reply) so cc-soul learns from the interaction.
   * @param satisfaction - Optional: 'positive' | 'negative'
   */
  async feedback(
    userMessage: string,
    aiReply: string,
    userId: string,
    satisfaction?: 'positive' | 'negative',
  ): Promise<FeedbackResult> {
    return this._post<FeedbackResult>('/feedback', {
      user_message: userMessage,
      ai_reply: aiReply,
      user_id: userId,
      ...(satisfaction ? { satisfaction } : {}),
    })
  }

  /**
   * Get user profile (avatar stats, social graph, identity, mood).
   * @param userId - If omitted, returns owner profile.
   */
  async profile(userId?: string): Promise<ProfileResult> {
    if (userId) {
      return this._post<ProfileResult>('/profile', { user_id: userId })
    }
    return this._get<ProfileResult>('/profile')
  }

  /**
   * Query structured facts via the /command endpoint.
   * Sends "事实 [query]" command to retrieve learned facts.
   * @param query - Optional filter query
   */
  async facts(query?: string): Promise<{ handled: boolean; reply: string }> {
    const message = query ? `事实 ${query}` : '事实'
    return this._post<{ handled: boolean; reply: string }>('/command', { message })
  }

  /**
   * Recall memories within a time range.
   * Uses the /command endpoint with "记忆搜索" command.
   * @param range - { from, to } timestamps in ms
   * @param options - scope filter, limit
   */
  async recallByTime(
    range: TimeRange,
    options?: RecallOptions,
  ): Promise<{ handled: boolean; reply: string }> {
    const from = new Date(range.from).toISOString().slice(0, 10)
    const to = range.to ? new Date(range.to).toISOString().slice(0, 10) : '今天'
    let message = `记忆搜索 ${from} ${to}`
    if (options?.scope) message += ` scope:${options.scope}`
    if (options?.limit) message += ` limit:${options.limit}`
    return this._post<{ handled: boolean; reply: string }>('/command', { message })
  }

  /**
   * Get all feature flags (enabled/disabled states).
   */
  async features(): Promise<FeatureEntry> {
    return this._get<FeatureEntry>('/features')
  }

  /**
   * Health check — verify the soul engine is running.
   */
  async health(): Promise<HealthResult> {
    return this._get<HealthResult>('/health')
  }

  /**
   * Send a raw command to the soul engine.
   * @param command - The command string (e.g., "状态", "诊断")
   * @param userId - Optional user ID
   */
  async command(command: string, userId?: string): Promise<{ handled: boolean; reply: string }> {
    return this._post<{ handled: boolean; reply: string }>('/command', {
      message: command,
      ...(userId ? { user_id: userId } : {}),
    })
  }
}

export default CCSoul
