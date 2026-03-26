#!/bin/bash
# cc-soul 手动升级触发器
# 用法: bash ~/.openclaw/hooks/cc-soul/scripts/upgrade.sh

echo "🔄 触发 cc-soul 自我升级诊断..."

# 通过 node 直接执行诊断 + 升级
cd ~/.openclaw/hooks/cc-soul/cc-soul

node --import tsx -e "
import { checkSoulUpgrade } from './upgrade.ts'

const stats = {
  totalMessages: 0,
  firstSeen: Date.now(),
  corrections: 0,
  positiveFeedback: 0,
  tasks: 0,
  topics: new Set(),
}

// 读取实际 stats
try {
  const fs = await import('fs')
  const raw = JSON.parse(fs.readFileSync('../data/stats.json', 'utf-8'))
  stats.totalMessages = raw.totalMessages || 0
  stats.firstSeen = raw.firstSeen || Date.now()
  stats.corrections = raw.corrections || 0
  stats.positiveFeedback = raw.positiveFeedback || 0
  stats.tasks = raw.tasks || 0
} catch {}

console.log('Stats:', JSON.stringify(stats))
checkSoulUpgrade(stats)
console.log('✅ 升级诊断已触发，结果会私聊通知你')
" 2>&1

echo ""
echo "查看日志: tail -f /tmp/openclaw-gateway.log | grep upgrade"
