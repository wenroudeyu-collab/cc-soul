/**
 * federation.ts — Knowledge Hub client (multi-user knowledge network)
 *
 * Opt-in system: users can share global knowledge with the network
 * and receive knowledge from other cc-soul instances.
 *
 * Privacy: PII filtering before upload, only global facts/discoveries.
 */

import type { SoulModule } from './brain.ts'
import { createHash } from 'crypto'
import type { FederationMemory } from './types.ts'
import { SYNC_CONFIG_PATH, saveJson } from './persistence.ts'
import { memoryState, addMemory } from './memory.ts'
import { evalMetrics } from './quality.ts'
import { getSyncConfig, getInstanceId } from './sync.ts'
import { rules, addRule } from './evolution.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// PII FILTER — strip sensitive data before uploading
// ═══════════════════════════════════════════════════════════════════════════════

const PII_PATTERNS = [
  /\b1[3-9]\d{9}\b/g,                              // Chinese phone numbers
  /\b\d{17}[\dXx]\b/g,                             // Chinese ID card
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email
  /\b(?:sk-|api[_-]?key|token|secret|password)[=:]\s*\S+/gi, // API keys/secrets
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,  // Credit card numbers
  /\b(?:ssh-rsa|ssh-ed25519)\s+\S+/g,              // SSH keys
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,      // IP address
  /(?:微信|wechat|telegram|discord)[:\s]*\S+/gi,    // Social accounts
]

function stripPII(text: string): string {
  let clean = text
  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0
    clean = clean.replace(pattern, '[REDACTED]')
  }
  return clean
}

function hasPII(text: string): boolean {
  return PII_PATTERNS.some(p => { p.lastIndex = 0; return p.test(text) })
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-REGISTER — first-time setup, no manual curl needed
// ═══════════════════════════════════════════════════════════════════════════════

let autoRegisterAttempted = false

/**
 * Auto-register with the Hub on first use.
 * If hubUrl is configured but hubApiKey is empty → register automatically.
 * Saves the received key to sync_config.json.
 */
export async function autoRegisterIfNeeded(): Promise<boolean> {
  const config = getSyncConfig()

  // Already has a key, or not configured, or already tried
  if (config.hubApiKey || !config.hubUrl || !config.federationEnabled || autoRegisterAttempted) {
    return Boolean(config.hubApiKey)
  }

  autoRegisterAttempted = true
  const instanceId = getInstanceId()
  const instanceName = config.instanceName || 'unnamed'

  try {
    const resp = await fetch(`${config.hubUrl}/federation/auto-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId, instanceName }),
    })

    if (!resp.ok) {
      console.error(`[cc-soul][federation] auto-register failed: ${resp.status}`)
      return false
    }

    const data = await resp.json() as any
    if (data.key) {
      // Save key to config
      config.hubApiKey = data.key
      saveJson(SYNC_CONFIG_PATH, config)
      console.log(`[cc-soul][federation] auto-registered! key: ${data.key.slice(0, 10)}...`)
      return true
    }
  } catch (e: any) {
    console.error(`[cc-soul][federation] auto-register error: ${e.message}`)
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD — share global knowledge with the hub
// ═══════════════════════════════════════════════════════════════════════════════

let lastUpload = 0
const UPLOAD_COOLDOWN = 6 * 3600000 // every 6 hours

export async function uploadToHub(): Promise<number> {
  const config = getSyncConfig()
  if (!config.federationEnabled || !config.hubUrl) return 0
  // Auto-register if no key yet
  if (!config.hubApiKey) {
    const ok = await autoRegisterIfNeeded()
    if (!ok) return 0
  }

  const now = Date.now()
  if (now - lastUpload < UPLOAD_COOLDOWN) return 0
  lastUpload = now

  // Collect shareable memories: global facts and discoveries only
  // IMPORTANT: exclude [网络知识] — these came from Hub, don't upload back
  const shareable = memoryState.memories
    .filter(m =>
      (m.scope === 'fact' || m.scope === 'discovery' || m.scope === 'consolidated') &&
      m.visibility === 'global' &&
      m.content.length > 10 &&
      !m.content.startsWith('[网络知识') &&
      !hasPII(m.content)
    )
    .map(m => ({
      content: stripPII(m.content),
      scope: m.scope,
      tags: m.tags,
      sourceInstance: getInstanceId(),
      sourceQuality: evalMetrics.avgQuality,
      timestamp: m.ts,
      contentHash: contentHash(m.content),
    } satisfies FederationMemory))

  // P2-#14: upload proven rules (hitCount >= 3) anonymously
  const shareableRules = rules
    .filter(r => r.hits >= 3 && r.rule.length > 5 && !hasPII(r.rule))
    .map(r => ({ rule: stripPII(r.rule), hits: r.hits }))

  if (shareable.length === 0 && shareableRules.length === 0) return 0

  try {
    const resp = await fetch(`${config.hubUrl}/federation/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.hubApiKey}`,
        'X-Instance-Id': getInstanceId(),
        'X-Quality-Score': String(evalMetrics.avgQuality),
      },
      body: JSON.stringify({ memories: shareable, rules: shareableRules }),
    })

    if (resp.ok) {
      const result = await resp.json() as any
      console.log(`[cc-soul][federation] uploaded ${shareable.length} memories, accepted: ${result.accepted || '?'}`)
      return result.accepted || shareable.length
    }
    console.error(`[cc-soul][federation] upload failed: ${resp.status}`)
  } catch (e: any) {
    console.error(`[cc-soul][federation] upload error: ${e.message}`)
  }
  return 0
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD — receive knowledge from the network
// ═══════════════════════════════════════════════════════════════════════════════

let lastDownload = 0
const DOWNLOAD_COOLDOWN = 6 * 3600000

export async function downloadFromHub(): Promise<number> {
  const config = getSyncConfig()
  if (!config.federationEnabled || !config.hubUrl) return 0
  // Auto-register if no key yet
  if (!config.hubApiKey) {
    const ok = await autoRegisterIfNeeded()
    if (!ok) return 0
  }

  const now = Date.now()
  if (now - lastDownload < DOWNLOAD_COOLDOWN) return 0
  lastDownload = now

  try {
    const resp = await fetch(
      `${config.hubUrl}/federation/download?since=${config.lastSync}&instance=${getInstanceId()}`,
      {
        headers: {
          'Authorization': `Bearer ${config.hubApiKey}`,
          'X-Instance-Id': getInstanceId(),
        },
      },
    )

    if (!resp.ok) {
      console.error(`[cc-soul][federation] download failed: ${resp.status}`)
      return 0
    }

    const data = await resp.json() as { memories: FederationMemory[] }
    if (!data.memories || data.memories.length === 0) return 0

    // Build existing hash set for dedup
    const existingHashes = new Set(
      memoryState.memories.map(m => contentHash(m.content))
    )

    let imported = 0
    for (const fm of data.memories) {
      if (fm.sourceInstance === getInstanceId()) continue
      if (existingHashes.has(fm.contentHash)) continue
      if (fm.sourceQuality < 5) continue
      if (hasPII(fm.content)) continue

      // Calculate trust score: higher source quality + more recent = more trusted
      const agedays = (Date.now() - fm.timestamp) / 86400000
      const freshness = Math.max(0.3, 1 - agedays / 365) // decays over a year
      const trustScore = (fm.sourceQuality / 10) * freshness

      // Skip very old knowledge (>180 days) unless high quality
      if (agedays > 180 && fm.sourceQuality < 7) continue

      // Tag with [网络知识] + trust level
      const trustLabel = trustScore > 0.7 ? '高可信' : trustScore > 0.4 ? '待验证' : '低可信'
      const content = `[网络知识|${trustLabel}] ${fm.content}`

      addMemory(content, fm.scope, undefined, 'global')
      existingHashes.add(fm.contentHash)
      imported++
    }

    // P2-#14: import rules from other instances with low weight
    const networkRules = (data as any).rules as { rule: string; hits: number }[] | undefined
    let rulesImported = 0
    if (networkRules && Array.isArray(networkRules)) {
      for (const nr of networkRules) {
        if (!nr.rule || nr.rule.length < 5 || hasPII(nr.rule)) continue
        if (rules.some(r => r.rule === nr.rule)) continue
        addRule(`[网络规则] ${stripPII(nr.rule)}`, 'federation')
        rulesImported++
      }
    }

    console.log(`[cc-soul][federation] downloaded ${data.memories.length} mems (imported ${imported}), ${rulesImported} rules`)
    return imported + rulesImported
  } catch (e: any) {
    console.error(`[cc-soul][federation] download error: ${e.message}`)
  }
  return 0
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO FEDERATION — called from heartbeat
// ═══════════════════════════════════════════════════════════════════════════════

export function autoFederate() {
  const config = getSyncConfig()
  if (!config.federationEnabled) return

  uploadToHub().catch(e => console.error(`[cc-soul][federation] auto-upload: ${e}`))
  downloadFromHub().catch(e => console.error(`[cc-soul][federation] auto-download: ${e}`))
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT — flag incorrect network knowledge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Report a network memory as incorrect/outdated.
 * Called when user corrects cc and the correction targets a [网络知识] memory.
 */
export async function reportBadKnowledge(memoryContent: string) {
  const config = getSyncConfig()
  if (!config.federationEnabled || !config.hubUrl || !config.hubApiKey) return

  const hash = contentHash(memoryContent.replace(/^\[网络知识[|｜][^\]]*\]\s*/, ''))

  try {
    await fetch(`${config.hubUrl}/federation/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.hubApiKey}`,
      },
      body: JSON.stringify({ contentHash: hash }),
    })
    console.log(`[cc-soul][federation] reported bad knowledge: ${memoryContent.slice(0, 60)}`)
  } catch (e: any) {
    console.error(`[cc-soul][federation] report failed: ${e.message}`)
  }
}

// ── SoulModule registration ──

export const federationModule: SoulModule = {
  id: 'federation',
  name: '知识联邦',
  dependencies: ['memory', 'sync'],
  priority: 50,
  enabled: false,  // 默认关闭，需手动启用
}
