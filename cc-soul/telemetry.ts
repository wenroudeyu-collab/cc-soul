/**
 * telemetry.ts — Anonymous usage statistics
 *
 * Reports anonymous aggregate stats to Hub (no chat content, no PII).
 * Users can disable via: 关闭 telemetry / features.json telemetry: false
 */

import { memoryState } from './memory.ts'
import { evalMetrics } from './quality.ts'
import { getSyncConfig, getInstanceId } from './sync.ts'
import { getAllFeatures, isEnabled } from './features.ts'
import { createHash } from 'crypto'
import type { SoulModule } from './brain.ts'

let lastReport = 0
const REPORT_INTERVAL = 24 * 3600000 // once per day

interface TelemetryPayload {
  id: string              // hashed instance ID (not raw)
  v: string               // cc-soul version
  msgs: number            // total messages
  mems: number            // memory count
  quality: number         // avg quality score
  corrections: number     // correction count
  features: number        // enabled feature count
  uptime: number          // days since first seen
}

function hashId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12)
}

/**
 * Send anonymous daily stats to Hub (if configured) or cc-soul telemetry endpoint.
 * Called from heartbeat. Respects feature toggle.
 */
export async function reportTelemetry(totalMessages: number, corrections: number, firstSeen: number) {
  if (!isEnabled('telemetry')) return

  const now = Date.now()
  if (now - lastReport < REPORT_INTERVAL) return
  lastReport = now

  const config = getSyncConfig()
  const hubUrl = config.hubUrl
  if (!hubUrl) return // no Hub configured, skip

  const features = getAllFeatures()
  const enabledCount = Object.values(features).filter(v => v === true).length

  const payload: TelemetryPayload = {
    id: hashId(getInstanceId()),           // anonymized
    v: '1.0.0',
    msgs: totalMessages,
    mems: memoryState.memories.length,
    quality: evalMetrics.avgQuality,
    corrections,
    features: enabledCount,
    uptime: Math.floor((now - firstSeen) / 86400000),
  }

  try {
    await fetch(`${hubUrl}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    console.log(`[cc-soul][telemetry] daily report sent (${payload.msgs} msgs, quality ${payload.quality})`)
  } catch (e: any) {
    // Silent fail — telemetry should never break anything
    console.log(`[cc-soul][telemetry] report failed (non-critical): ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUL MODULE — brain-managed lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

export const telemetryModule: SoulModule = {
  id: 'telemetry',
  name: '匿名遥测',
  priority: 10,
  dependencies: ['values'],
  enabled: false,  // 默认关闭，需手动启用

  onHeartbeat() {
    // Stats are read from handler-state at call time
    // For now, use memoryState as proxy for activity
    reportTelemetry(0, 0, 0)
  },
}
