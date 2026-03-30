/**
 * audit.ts — Immutable Audit Log with hash chain
 *
 * Records all important operations (memory CRUD, rule changes, upgrades, config).
 * Each entry's hash = sha256(prevHash + action + detail), forming a tamper-evident chain.
 */

import { createHash } from 'crypto'
import { resolve } from 'path'
import { DATA_DIR, loadJson, debouncedSave } from './persistence.ts'

const AUDIT_PATH = resolve(DATA_DIR, 'audit.json')
const MAX_ENTRIES = 1000

interface AuditEntry { ts: number; action: string; detail: string; hash: string; prevHash?: string }

let auditLog: AuditEntry[] = loadJson<AuditEntry[]>(AUDIT_PATH, [])

function computeHash(prevHash: string, ts: number, action: string, detail: string): string {
  return createHash('sha256').update(prevHash + '|' + ts + '|' + action + '|' + detail).digest('hex')
}

export function appendAudit(action: string, detail: string) {
  const prevHash = auditLog.length > 0 ? auditLog[auditLog.length - 1].hash : '0'.repeat(64)
  const ts = Date.now()
  const entry: AuditEntry = {
    ts,
    action,
    detail: detail.slice(0, 200),
    hash: computeHash(prevHash, ts, action, detail.slice(0, 200)),
  }
  auditLog.push(entry)
  if (auditLog.length > MAX_ENTRIES) {
    const keepCount = Math.floor(MAX_ENTRIES * 0.8)
    const discarded = auditLog.slice(0, auditLog.length - keepCount)
    if (discarded.length === 0) return
    const lastDiscardedHash = discarded[discarded.length - 1].hash
    const kept = auditLog.slice(-keepCount)
    const anchor: AuditEntry = {
      ts: Date.now(),
      action: 'chain-anchor',
      detail: 'truncated',
      hash: lastDiscardedHash,
      prevHash: '',
    }
    auditLog.length = 0
    auditLog.push(anchor, ...kept)
  }
  debouncedSave(AUDIT_PATH, auditLog)
}

/** Format recent N entries for display */
export function formatAuditLog(n = 20): string {
  const recent = auditLog.slice(-n)
  if (recent.length === 0) return '审计日志为空'
  return recent.map(e => {
    const time = new Date(e.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    return `[${time}] ${e.action}: ${e.detail} (${e.hash.slice(0, 8)})`
  }).join('\n')
}

/** Check if the audit command was triggered */
export function isAuditCommand(msg: string): boolean {
  const m = msg.trim()
  return m === '审计日志' || m === 'audit log' || m === '审计'
}

export { auditLog }
