import type { SoulModule } from './brain.ts'

/**
 * sync.ts — Cross-device memory sync
 *
 * Exports global memories/rules/entities as JSONL for sync between
 * devices (Mac ↔ VPS, or any two cc-soul instances).
 *
 * Methods:
 * - file: export/import JSONL files (rsync/git/manual copy)
 * - http: push/pull from a sync endpoint
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { createHash } from 'crypto'
import { resolve } from 'path'
import type { SyncConfig, SyncPacket, Memory, Rule, Entity } from './types.ts'
import {
  DATA_DIR, SYNC_CONFIG_PATH, SYNC_EXPORT_PATH, SYNC_IMPORT_PATH,
  loadJson, saveJson, debouncedSave,
} from './persistence.ts'
import { memoryState, addMemory } from './memory.ts'
import { rules, addRule } from './evolution.ts'
import { graphState, addEntity, addRelation } from './graph.ts'
import { lorebookEntries, addLorebookEntry } from './lorebook.ts'
import { skillLibrary, saveSkill } from './tasks.ts'

// ── Default config ──

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  instanceId: generateInstanceId(),
  instanceName: 'cc-default',
  method: 'file',
  federationEnabled: false,
  syncIntervalMinutes: 0,
  lastSync: 0,
}

function generateInstanceId(): string {
  return 'cc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// ── CRDT conflict resolution ──

/**
 * Resolve conflict between local and remote memory.
 * Strategy: last-write-wins for content, union-merge for tags.
 */
function resolveConflict(local: Memory, remote: Memory): Memory {
  // Merge tags as union if both have them
  const mergedTags = (local.tags || remote.tags)
    ? [...new Set([...(local.tags || []), ...(remote.tags || [])])]
    : undefined

  // Last-write-wins for all other fields
  const winner = (remote.ts > local.ts) ? { ...remote } : { ...local }
  if (mergedTags) winner.tags = mergedTags
  return winner
}

// ── State ──

let syncConfig: SyncConfig = loadJson<SyncConfig>(SYNC_CONFIG_PATH, DEFAULT_SYNC_CONFIG)

export function loadSyncConfig() {
  syncConfig = loadJson<SyncConfig>(SYNC_CONFIG_PATH, DEFAULT_SYNC_CONFIG)
  // Ensure instanceId exists
  if (!syncConfig.instanceId) {
    syncConfig.instanceId = generateInstanceId()
    saveJson(SYNC_CONFIG_PATH, syncConfig)
  }
  console.log(`[cc-soul][sync] instance: ${syncConfig.instanceId} (${syncConfig.instanceName}), sync: ${syncConfig.enabled ? 'ON' : 'OFF'}, federation: ${syncConfig.federationEnabled ? 'ON' : 'OFF'}`)
}

export function getSyncConfig(): SyncConfig {
  return syncConfig
}

export function getInstanceId(): string {
  return syncConfig.instanceId
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT — collect global data into JSONL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Export global (shareable) data as JSONL packets.
 * Only exports: visibility=global memories, verified rules, entities, skills, lorebook.
 *
 * @param since — if provided, only export items newer than this timestamp (incremental sync).
 *                Defaults to 0 (full export) for backward compatibility.
 */
export function exportSyncData(since = 0): number {
  const packets: SyncPacket[] = []
  const now = Date.now()
  const instanceId = syncConfig.instanceId

  // Global memories (exclude [网络知识] to prevent upload-download loops)
  for (const mem of memoryState.memories) {
    if (mem.visibility !== 'global' && mem.scope !== 'fact' && mem.scope !== 'discovery' && mem.scope !== 'consolidated') continue
    if (mem.scope === 'expired') continue
    if (mem.content.startsWith('[网络知识')) continue
    const ts = mem.ts || now
    if (since > 0 && ts <= since) continue  // incremental: skip old items
    packets.push({
      fromInstance: instanceId,
      timestamp: ts,
      type: 'memory',
      payload: { content: mem.content, scope: mem.scope, tags: mem.tags, emotion: mem.emotion },
      version: 1,
    })
  }

  // Verified rules (high-hit rules only)
  for (const rule of rules) {
    if (rule.hits < 2) continue
    if (since > 0 && rule.ts <= since) continue
    packets.push({
      fromInstance: instanceId,
      timestamp: rule.ts,
      type: 'rule',
      payload: { rule: rule.rule, source: rule.source, hits: rule.hits },
      version: 1,
    })
  }

  // Entities
  for (const entity of graphState.entities) {
    if (entity.mentions < 2) continue
    if (since > 0 && entity.firstSeen <= since) continue
    packets.push({
      fromInstance: instanceId,
      timestamp: entity.firstSeen,
      type: 'entity',
      payload: { name: entity.name, type: entity.type, attrs: entity.attrs, mentions: entity.mentions },
      version: 1,
    })
  }

  // Skills
  for (const skill of skillLibrary) {
    if (!skill.verified) continue
    if (since > 0 && skill.createdAt <= since) continue
    packets.push({
      fromInstance: instanceId,
      timestamp: skill.createdAt,
      type: 'skill',
      payload: { name: skill.name, description: skill.description, solution: skill.solution, keywords: skill.keywords },
      version: 1,
    })
  }

  // Lorebook entries
  for (const entry of lorebookEntries) {
    if (!entry.enabled) continue
    if (since > 0 && entry.createdAt <= since) continue
    packets.push({
      fromInstance: instanceId,
      timestamp: entry.createdAt,
      type: 'lorebook',
      payload: { keywords: entry.keywords, content: entry.content, priority: entry.priority, category: entry.category },
      version: 1,
    })
  }

  // Write JSONL
  const lines = packets.map(p => JSON.stringify(p)).join('\n')
  writeFileSync(SYNC_EXPORT_PATH, lines, 'utf-8')

  syncConfig.lastSync = now
  saveJson(SYNC_CONFIG_PATH, syncConfig)

  console.log(`[cc-soul][sync] exported ${packets.length} packets to ${SYNC_EXPORT_PATH}`)
  return packets.length
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT — ingest JSONL packets from another instance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import sync data from JSONL file. Deduplicates by content hash.
 */
export function importSyncData(): number {
  if (!existsSync(SYNC_IMPORT_PATH)) {
    console.log(`[cc-soul][sync] no import file found at ${SYNC_IMPORT_PATH}`)
    return 0
  }

  const raw = readFileSync(SYNC_IMPORT_PATH, 'utf-8')
  const lines = raw.split('\n').filter(l => l.trim())
  let imported = 0

  // Build hash set of existing memories for dedup
  const existingHashes = new Set(
    memoryState.memories.map(m => contentHash(m.content))
  )

  for (const line of lines) {
    try {
      const packet: SyncPacket = JSON.parse(line)

      // Skip own packets
      if (packet.fromInstance === syncConfig.instanceId) continue

      const payload = packet.payload || {}
      switch (packet.type) {
        case 'memory': {
          const hash = contentHash(payload.content)
          if (existingHashes.has(hash)) {
            // CRDT: resolve conflict if remote is newer
            const existing = memoryState.memories.find(m => contentHash(m.content) === hash)
            if (existing && packet.timestamp > existing.ts) {
              const resolved = resolveConflict(existing, {
                content: payload.content,
                scope: payload.scope,
                ts: packet.timestamp,
                tags: payload.tags,
                emotion: payload.emotion,
              })
              Object.assign(existing, resolved)
              imported++
            }
            continue
          }
          addMemory(payload.content, payload.scope, undefined, 'global')
          existingHashes.add(hash)
          imported++
          break
        }
        case 'rule': {
          if (!rules.some(r => r.rule === payload.rule)) {
            addRule(payload.rule, `sync:${packet.fromInstance}`)
            imported++
          }
          break
        }
        case 'entity': {
          addEntity(payload.name, payload.type, payload.attrs || [])
          imported++
          break
        }
        case 'skill': {
          if (!skillLibrary.some(s => s.name === payload.name)) {
            saveSkill(payload.name, payload.description, payload.solution, payload.keywords)
            imported++
          }
          break
        }
        case 'lorebook': {
          addLorebookEntry({
            keywords: payload.keywords,
            content: payload.content,
            priority: payload.priority || 5,
            enabled: true,
            category: payload.category || 'fact',
          })
          imported++
          break
        }
      }
    } catch (e: any) {
      console.error(`[cc-soul][sync] parse error: ${e.message}`)
    }
  }

  console.log(`[cc-soul][sync] imported ${imported} packets from ${lines.length} lines`)
  return imported
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SYNC — push/pull from remote endpoint
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Push local global data to a remote sync endpoint.
 */
export async function pushToRemote(): Promise<number> {
  if (!syncConfig.remote) {
    console.log(`[cc-soul][sync] no remote configured`)
    return 0
  }

  const count = exportSyncData(syncConfig.lastSync)
  if (count === 0) return 0

  try {
    const data = readFileSync(SYNC_EXPORT_PATH, 'utf-8')
    const resp = await fetch(syncConfig.remote + '/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/jsonl',
        'X-Instance-Id': syncConfig.instanceId,
        'X-Instance-Name': syncConfig.instanceName,
      },
      body: data,
    })
    if (resp.ok) {
      console.log(`[cc-soul][sync] pushed ${count} packets to ${syncConfig.remote}`)
      return count
    }
    console.error(`[cc-soul][sync] push failed: ${resp.status}`)
  } catch (e: any) {
    console.error(`[cc-soul][sync] push error: ${e.message}`)
  }
  return 0
}

/**
 * Pull new data from remote sync endpoint.
 */
export async function pullFromRemote(): Promise<number> {
  if (!syncConfig.remote) return 0

  try {
    const resp = await fetch(
      `${syncConfig.remote}/sync/pull?since=${syncConfig.lastSync}&instance=${syncConfig.instanceId}`,
      { headers: { 'X-Instance-Id': syncConfig.instanceId } },
    )
    if (!resp.ok) {
      console.error(`[cc-soul][sync] pull failed: ${resp.status}`)
      return 0
    }
    const data = await resp.text()
    writeFileSync(SYNC_IMPORT_PATH, data, 'utf-8')
    return importSyncData()
  } catch (e: any) {
    console.error(`[cc-soul][sync] pull error: ${e.message}`)
    return 0
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO SYNC — called from heartbeat
// ═══════════════════════════════════════════════════════════════════════════════

let lastAutoSync = 0

export function autoSync() {
  if (!syncConfig.enabled) return
  if (syncConfig.syncIntervalMinutes <= 0) return

  const now = Date.now()
  const intervalMs = syncConfig.syncIntervalMinutes * 60000
  if (now - lastAutoSync < intervalMs) return
  lastAutoSync = now

  if (syncConfig.method === 'http' && syncConfig.remote) {
    pushToRemote().catch(e => console.error(`[cc-soul][sync] auto-push failed: ${e}`))
    pullFromRemote().catch(e => console.error(`[cc-soul][sync] auto-pull failed: ${e}`))
  } else if (syncConfig.method === 'file') {
    exportSyncData(syncConfig.lastSync)  // incremental: only export since last sync
    importSyncData()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL TRIGGER — detect sync commands from user messages
// ═══════════════════════════════════════════════════════════════════════════════

export function handleSyncCommand(msg: string): boolean {
  const m = msg.trim()

  if (m === '同步知识' || m === '导出知识' || m === 'sync export') {
    const count = exportSyncData()
    console.log(`[cc-soul][sync] manual export: ${count} packets`)
    return true
  }

  if (m === '导入知识' || m === 'sync import') {
    const count = importSyncData()
    console.log(`[cc-soul][sync] manual import: ${count} packets`)
    return true
  }

  if (m === '同步状态' || m === 'sync status') {
    console.log(`[cc-soul][sync] instance=${syncConfig.instanceId} name=${syncConfig.instanceName} enabled=${syncConfig.enabled} lastSync=${new Date(syncConfig.lastSync).toLocaleString()}`)
    return true
  }

  return false
}

export const syncModule: SoulModule = {
  id: 'sync',
  name: '跨设备同步',
  dependencies: ['memory', 'evolution'],
  priority: 50,
  enabled: false,  // 默认关闭，需手动启用
  init() { loadSyncConfig() },
}
