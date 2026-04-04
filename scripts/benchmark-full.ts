/**
 * cc-soul NAM 全量 Benchmark（带实时进度）
 *
 * 用法: npx tsx scripts/benchmark-full.ts
 *
 * 6 个阶段，预计 40 分钟：
 *   [1] 系统健康检查
 *   [2] 中文 80 题
 *   [3] 英文 80 题
 *   [4] 学习曲线 1200 条
 *   [5] LOCOMO recall-only 全量
 *   [6] LOCOMO + LLM 全量
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'

const require = createRequire(import.meta.url)
;(globalThis as any).require = require

// 禁用 activation-field 的 LLM 兜底（避免 spawnCLI 阻塞 benchmark）
process.env.CC_SOUL_BENCHMARK = '1'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// 进度显示
function progress(stage: string, current: number, total: number, extra = '') {
  const pct = Math.round(current / total * 100)
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5))
  process.stdout.write(`\r  [${bar}] ${pct}% (${current}/${total}) ${extra}`)
  if (current === total) process.stdout.write('\n')
}

function printHeader(stage: number, title: string) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  [${stage}/6] ${title}`)
  console.log('═'.repeat(60))
}

// 结果收集
const RESULTS: any = { timestamp: new Date().toISOString() }

async function main() {
  console.log('═'.repeat(60))
  console.log('  cc-soul NAM Full Benchmark')
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('═'.repeat(60))

  // ═══════════════════════════════════════
  // [1] 系统健康检查
  // ═══════════════════════════════════════
  printHeader(1, '系统健康检查')

  const health: Record<string, string> = {}

  // 情绪
  try {
    const body = require(join(PROJECT_ROOT, 'cc-soul/body.ts'))
    health['情绪向量'] = body.body?.mood !== undefined ? `✅ mood=${body.body.mood}` : '❌ 无数据'
  } catch { health['情绪向量'] = '❌ 加载失败' }

  // CIN
  try {
    const cin = require(join(PROJECT_ROOT, 'cc-soul/cin.ts'))
    const field = cin.getFieldSummary?.()
    health['CIN'] = field?.risk ? `✅ risk=${field.risk.direction}` : '❌ 无数据'
  } catch { health['CIN'] = '❌ 加载失败' }

  // Fact Store
  try {
    const fs = require(join(PROJECT_ROOT, 'cc-soul/fact-store.ts'))
    const count = fs.getAllFacts?.()?.length || 0
    health['Fact Store'] = count > 0 ? `✅ ${count} 条` : '❌ 空'
  } catch { health['Fact Store'] = '❌ 加载失败' }

  // Graph
  try {
    const graph = require(join(PROJECT_ROOT, 'cc-soul/graph.ts'))
    const entities = graph.graphState?.entities?.length || 0
    const relations = graph.graphState?.relations?.length || 0
    health['图谱'] = entities > 0 ? `✅ ${entities} 实体 ${relations} 关系` : '❌ 空'
  } catch { health['图谱'] = '❌ 加载失败' }

  // Distill
  try {
    const distill = require(join(PROJECT_ROOT, 'cc-soul/distill.ts'))
    const stats = distill.getDistillStats?.()
    health['蒸馏'] = stats?.topicNodeCount > 0 ? `✅ ${stats.topicNodeCount} nodes` : '❌ 未运行'
  } catch { health['蒸馏'] = '❌ 加载失败' }

  for (const [k, v] of Object.entries(health)) {
    console.log(`  ${v.startsWith('✅') ? '✅' : '❌'} ${k}: ${v.replace(/^[✅❌] /, '')}`)
  }
  RESULTS.health = health

  // ═══════════════════════════════════════
  // [2] 中文 80 题
  // ═══════════════════════════════════════
  printHeader(2, '中文 Benchmark (40 mem × 80 query)')

  try {
    // 动态加载 benchmark
    const benchPath = join(PROJECT_ROOT, 'cc-soul/benchmark-recall.ts')
    // 执行并捕获输出
    const { execSync } = require('child_process')
    const output = execSync(`npx tsx ${benchPath}`, {
      cwd: PROJECT_ROOT, timeout: 300000, encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', CC_SOUL_BENCHMARK: '1' }
    })

    // 解析结果
    const lines = output.split('\n')
    const directLine = lines.find((l: string) => l.includes('直接召回'))
    const semanticLine = lines.find((l: string) => l.includes('语义召回'))
    const totalLine = lines.find((l: string) => l.includes('总体'))
    const top1Line = lines.find((l: string) => l.includes('Top-1'))

    RESULTS.chinese = {
      direct: directLine?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
      semantic: semanticLine?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
      total: totalLine?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
      top1: top1Line?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
    }
    console.log(`  直接: ${RESULTS.chinese.direct}  语义: ${RESULTS.chinese.semantic}  总体: ${RESULTS.chinese.total}  Top-1: ${RESULTS.chinese.top1}`)
  } catch (e: any) {
    console.log(`  ❌ 错误: ${e.message?.slice(0, 100)}`)
    RESULTS.chinese = { error: e.message?.slice(0, 200) }
  }

  // ═══════════════════════════════════════
  // [3] 英文 80 题
  // ═══════════════════════════════════════
  printHeader(3, '英文 Benchmark (40 mem × 80 query)')

  try {
    const { execSync } = require('child_process')
    const output = execSync(`npx tsx ${join(PROJECT_ROOT, 'cc-soul/benchmark-recall-en.ts')}`, {
      cwd: PROJECT_ROOT, timeout: 300000, encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', CC_SOUL_BENCHMARK: '1' }
    })

    const lines = output.split('\n')
    const directLine = lines.find((l: string) => l.includes('Direct recall'))
    const semanticLine = lines.find((l: string) => l.includes('Semantic recall'))
    const totalLine = lines.find((l: string) => l.includes('Overall'))
    const top1Line = lines.find((l: string) => l.includes('Top-1'))

    RESULTS.english = {
      direct: directLine?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
      semantic: semanticLine?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
      total: totalLine?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
      top1: top1Line?.match(/(\d+)\/(\d+)\s*=\s*(\d+)%/)?.[3] + '%' || '?',
    }
    console.log(`  Direct: ${RESULTS.english.direct}  Semantic: ${RESULTS.english.semantic}  Overall: ${RESULTS.english.total}  Top-1: ${RESULTS.english.top1}`)
  } catch (e: any) {
    console.log(`  ❌ 错误: ${e.message?.slice(0, 100)}`)
    RESULTS.english = { error: e.message?.slice(0, 200) }
  }

  // ═══════════════════════════════════════
  // [4] 学习曲线
  // ═══════════════════════════════════════
  printHeader(4, '学习曲线 (1200 条 × 10 checkpoints)')

  try {
    const { execSync } = require('child_process')
    const output = execSync(`npx tsx ${join(PROJECT_ROOT, 'cc-soul/benchmark-learning-curve.ts')}`, {
      cwd: PROJECT_ROOT, timeout: 600000, encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', CC_SOUL_BENCHMARK: '1' }
    })

    // 提取 checkpoint 数据
    const checkpoints: any[] = []
    const cpLines = output.split('\n').filter((l: string) => l.includes('[Checkpoint'))
    for (const line of cpLines) {
      const m = line.match(/\[Checkpoint\s+(\d+)\]\s+Hit@3=([0-9.]+)%.*?D:([0-9.]+)%.*?S:([0-9.]+)%.*?Top-1=([0-9.]+)%.*?Vocab=(\d+).*?Latency=([0-9.]+)ms/)
      if (m) {
        checkpoints.push({
          messages: parseInt(m[1]),
          hit3: m[2] + '%',
          direct: m[3] + '%',
          semantic: m[4] + '%',
          top1: m[5] + '%',
          vocab: parseInt(m[6]),
          latency: m[7] + 'ms',
        })
      }
    }

    RESULTS.learningCurve = checkpoints
    console.log('  | Messages | Hit@3  | Direct | Semantic | Top-1  | Latency |')
    console.log('  |----------|--------|--------|----------|--------|---------|')
    for (const cp of checkpoints) {
      console.log(`  | ${String(cp.messages).padStart(8)} | ${cp.hit3.padStart(6)} | ${cp.direct.padStart(6)} | ${cp.semantic.padStart(8)} | ${cp.top1.padStart(6)} | ${cp.latency.padStart(7)} |`)
    }
  } catch (e: any) {
    console.log(`  ❌ 错误: ${e.message?.slice(0, 100)}`)
    RESULTS.learningCurve = { error: e.message?.slice(0, 200) }
  }

  // ═══════════════════════════════════════
  // [5] LOCOMO recall-only 全量
  // ═══════════════════════════════════════
  printHeader(5, 'LOCOMO-MC10 Recall-Only (1986 题)')

  try {
    const { execSync } = require('child_process')
    const output = execSync(`npx tsx ${join(PROJECT_ROOT, 'cc-soul/benchmark-locomo.ts')} --recall-only`, {
      cwd: PROJECT_ROOT, timeout: 1200000, encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1', CC_SOUL_BENCHMARK: '1' }
    })

    const lines = output.split('\n')
    // 提取结果
    const totalLine = lines.find((l: string) => l.includes('TOTAL') && l.includes('Hit'))
    RESULTS.locomoRecall = { raw: lines.filter((l: string) => l.includes('Hit@') || l.includes('TOTAL') || l.includes('MRR') || l.includes('Time')).join('\n') }

    // 打印关键行
    for (const l of lines) {
      if (l.includes('Hit@') || l.includes('TOTAL') || l.includes('──') || l.includes('Type') || l.includes('Time') || l.includes('MRR') || l.includes('baseline')) {
        console.log(l)
      }
    }
  } catch (e: any) {
    console.log(`  ❌ 错误: ${e.message?.slice(0, 100)}`)
    RESULTS.locomoRecall = { error: e.message?.slice(0, 200) }
  }

  // ═══════════════════════════════════════
  // [6] LOCOMO + LLM 全量
  // ═══════════════════════════════════════
  printHeader(6, 'LOCOMO-MC10 + Kimi k2.5 (1986 题)')

  try {
    const { execSync } = require('child_process')
    const output = execSync(`npx tsx ${join(PROJECT_ROOT, 'cc-soul/benchmark-locomo.ts')} --llm`, {
      cwd: PROJECT_ROOT, timeout: 7200000, encoding: 'utf-8', // 2 hour timeout
      env: { ...process.env, NODE_NO_WARNINGS: '1', CC_SOUL_BENCHMARK: '1' }
    })

    const lines = output.split('\n')
    RESULTS.locomoLLM = { raw: lines.filter((l: string) => l.includes('Acc') || l.includes('TOTAL') || l.includes('──') || l.includes('Type') || l.includes('Time') || l.includes('SM') || l.includes('LLM')).join('\n') }

    for (const l of lines) {
      if (l.includes('Acc') || l.includes('TOTAL') || l.includes('──') || l.includes('Type') || l.includes('Time') || l.includes('SM') || l.includes('LLM') || l.includes('baseline')) {
        console.log(l)
      }
    }
  } catch (e: any) {
    console.log(`  ❌ 错误: ${e.message?.slice(0, 100)}`)
    RESULTS.locomoLLM = { error: e.message?.slice(0, 200) }
  }

  // ═══════════════════════════════════════
  // 保存报告
  // ═══════════════════════════════════════
  console.log('\n' + '═'.repeat(60))
  console.log('  全部完成！')
  console.log('═'.repeat(60))

  const reportPath = '/Users/z/Documents/下一步计划/cc_soul_benchmark_results.json'
  writeFileSync(reportPath, JSON.stringify(RESULTS, null, 2))
  console.log(`\n  结果已保存: ${reportPath}`)
  console.log(`  完成时间: ${new Date().toLocaleString()}`)
}

main().catch(e => {
  console.error('Benchmark failed:', e.message)
  process.exit(1)
})
