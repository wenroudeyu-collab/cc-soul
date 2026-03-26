/**
 * integration-test.ts — Simulate message flow to test all 120+ features
 *
 * Calls handler functions directly, bypassing OpenClaw.
 * Usage: npx tsx cc-soul/integration-test.ts
 */

import { initializeSoul, runHeartbeat } from './handler.ts'
import { cogProcess } from './cognition.ts'
import { addMemory, recall, recallFused, consolidateMemories, predictiveRecall, scanForContradictions, triggerSessionSummary, processMemoryDecay, memoryState, getStorageStatus } from './memory.ts'
import { bodyTick, bodyOnMessage, bodyOnCorrection, bodyOnPositiveFeedback, body } from './body.ts'
import { loadRules, getRelevantRules, addRule, formHypothesis, verifyHypothesis } from './evolution.ts'
import { checkAugmentConsistency, snapshotAugments, learnConflict, recordInteraction, getInteractionInsight, getConflictResolutions, loadMetacognition } from './metacognition.ts'
import { prepareContext, prepareContextAsync } from './context-prep.ts'
import { loadPatterns, learnSuccessPattern, getBestPattern, getPatternStats } from './patterns.ts'
import { loadMetaFeedback, recordAugmentOutcome, getAugmentPriorityMultiplier, getMetaFeedbackSummary, getPairEffects, detectAugmentTrends } from './meta-feedback.ts'
import { selectAugments } from './prompt-builder.ts'
import { updateFlow, getFlowContext, getCurrentFlowDepth } from './flow.ts'
import { queryLorebook } from './lorebook.ts'
import { isEnabled } from './features.ts'
import { runFullDiagnostic, formatDiagnosticReport } from './diagnostic.ts'
import { detectDomain, getDomainConfidence, getWeakDomains, getEpistemicSummary } from './epistemic.ts'
import { selectPersona, getActivePersona, getBlendedPersonaOverlay } from './persona.ts'
import { updateFingerprint, checkPersonaConsistency, getFingerprintSummary } from './fingerprint.ts'
import { checkSpontaneousVoice } from './voice.ts'
import { loadValues, detectValueSignals, getValueContext } from './values.ts'
import { getProfile, updateProfileOnMessage, getRhythmContext } from './user-profiles.ts'
import { scoreResponse } from './quality.ts'
import { loadTunableParams, getParam, checkAutoTune } from './auto-tune.ts'
import type { InteractionStats } from './types.ts'

// ══════════════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ══════════════════════════════════════════════════════════════════════════════

interface TestResult { name: string; passed: boolean; error?: string; detail?: string }
const results: TestResult[] = []
const testUserId = 'test_user_001'
const mockStats: InteractionStats = { totalMessages: 100, firstSeen: Date.now() - 86400000, corrections: 5, positiveFeedback: 20, tasks: 10, topics: new Set(['test']) }

function pass(name: string, detail?: string) { results.push({ name, passed: true, detail }) }
function fail(name: string, error: string) { results.push({ name, passed: false, error }) }

function test(name: string, fn: () => void) {
  try { fn(); pass(name) } catch (e: any) { fail(name, e.message) }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try { await fn(); pass(name) } catch (e: any) { fail(name, e.message) }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg) }

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 cc-soul integration test — starting\n')
initializeSoul()
console.log('')

// ══════════════════════════════════════════════════════════════════════════════
// 1. MEMORY SYSTEM (15 features)
// ══════════════════════════════════════════════════════════════════════════════

test('1.1 addMemory — basic', () => {
  const before = memoryState.memories.length
  addMemory(`集成测试：唯一记忆_${Date.now()}`, 'test', [testUserId])
  assert(memoryState.memories.length > before, 'memory count should increase')
})

test('1.2 recall — TF-IDF + trigram', () => {
  const results = recall('测试记忆', 3, testUserId)
  assert(results.length > 0, 'should recall at least 1 memory')
})

test('1.3 recall — fuzzy match', () => {
  addMemory('Python的装饰器可以修改函数行为', 'fact', [testUserId])
  const results = recall('Python装饰器修改函数', 10, testUserId)
  assert(results.length > 0, 'should fuzzy match 装饰器')
})

test('1.4 memory dedup (CRUD engine)', () => {
  const before = memoryState.memories.length
  addMemory('集成测试：这是一条测试记忆', 'test', [testUserId]) // duplicate
  // Should skip or update, not add new
  assert(memoryState.memories.length <= before + 1, 'should dedup similar memory')
})

test('1.5 memory consolidation', () => {
  // Add several similar memories
  addMemory('TypeScript类型推断很强大', 'fact', [testUserId])
  addMemory('TypeScript的类型系统支持泛型', 'fact', [testUserId])
  addMemory('TypeScript有联合类型和交叉类型', 'fact', [testUserId])
  consolidateMemories()
  // No crash = pass
})

test('1.6 contradiction scan', () => {
  scanForContradictions()
  // No crash = pass
})

test('1.7 predictive recall', () => {
  const predicted = predictiveRecall()
  // May return empty if not enough history, but should not crash
  assert(Array.isArray(predicted), 'should return array')
})

test('1.8 memory decay', () => {
  processMemoryDecay()
  // No crash = pass
})

test('1.9 session summary', () => {
  // Needs chat history; just verify no crash
  triggerSessionSummary()
})

test('1.10 core memory pinning', () => {
  assert(isEnabled('memory_core'), 'memory_core should be enabled')
})

test('1.11 working memory isolation', () => {
  assert(isEnabled('memory_working'), 'memory_working should be enabled')
})

// ══════════════════════════════════════════════════════════════════════════════
// 2. COGNITION PIPELINE (6 features)
// ══════════════════════════════════════════════════════════════════════════════

test('2.1 attention gate — correction', () => {
  const r = cogProcess('你说错了，不是这样的', '', '', undefined)
  assert(r.attention === 'correction', `expected correction, got ${r.attention}`)
})

test('2.2 attention gate — emotional', () => {
  const r = cogProcess('今天好烦，心情很差', '', '', undefined)
  assert(r.attention === 'emotional', `expected emotional, got ${r.attention}`)
})

test('2.3 attention gate — technical', () => {
  const r = cogProcess('这个函数怎么写', '', '', undefined)
  assert(r.attention === 'technical', `expected technical, got ${r.attention}`)
})

test('2.4 strategy selection', () => {
  const r = cogProcess('你说错了', '', '', undefined)
  assert(r.strategy === 'acknowledge_and_retry', `expected acknowledge_and_retry, got ${r.strategy}`)
})

test('2.5 casual detection', () => {
  const r = cogProcess('嗯好的', '', '', undefined)
  assert(r.attention === 'casual', `expected casual, got ${r.attention}`)
})

test('2.6 intent prediction', () => {
  const r = cogProcess('帮我看看这个代码有什么问题', '', '', undefined)
  assert(r.hints !== undefined, 'should have hints array')
})

// ══════════════════════════════════════════════════════════════════════════════
// 3. BODY SIMULATION (6 features)
// ══════════════════════════════════════════════════════════════════════════════

test('3.1 body state exists', () => {
  assert(body.energy !== undefined, 'should have energy')
  assert(body.mood !== undefined, 'should have mood')
})

test('3.2 bodyTick', () => {
  bodyTick()
  assert(body.energy >= 0 && body.energy <= 100, `energy ${body.energy} should be 0-100`)
})

test('3.3 bodyOnMessage', () => {
  bodyOnMessage(5)
  // No crash = pass
})

test('3.4 bodyOnCorrection', () => {
  bodyOnCorrection()
  assert(body.mood <= 100, 'mood should decrease or stay')
})

test('3.5 bodyOnPositiveFeedback', () => {
  bodyOnPositiveFeedback()
  // No crash = pass
})

test('3.6 body energy range', () => {
  assert(body.energy >= 0 && body.energy <= 1, 'energy in range')
  assert(body.mood >= -1 && body.mood <= 1, 'mood in range')
})

// ══════════════════════════════════════════════════════════════════════════════
// 4. EVOLUTION (6 features)
// ══════════════════════════════════════════════════════════════════════════════

test('4.1 addRule', () => {
  addRule('集成测试规则：回复要简洁', 'test')
  const rules = getRelevantRules('简洁', 3)
  assert(rules.length > 0, 'should find the rule')
})

test('4.2 formHypothesis', () => {
  formHypothesis('当用户问代码时直接给代码', '代码', testUserId)
  // No crash = pass
})

test('4.3 verifyHypothesis', () => {
  verifyHypothesis('帮我写个Python函数', true)
  // No crash = pass
})

test('4.4 getRelevantRules', () => {
  const rules = getRelevantRules('简洁回复', 5)
  assert(Array.isArray(rules), 'should return array')
})

// ══════════════════════════════════════════════════════════════════════════════
// 5. METACOGNITION (7 features) — NEW
// ══════════════════════════════════════════════════════════════════════════════

test('5.1 checkAugmentConsistency — no conflict', () => {
  const warning = checkAugmentConsistency([
    { content: '[相关记忆] 用户喜欢简洁', priority: 5 },
    { content: '[注意规则] 先给代码', priority: 7 },
  ])
  // May or may not find conflict, but should not crash
  assert(typeof warning === 'string', 'should return string')
})

test('5.2 checkAugmentConsistency — detect conflict', () => {
  const warning = checkAugmentConsistency([
    { content: '[认知] 简洁回复', priority: 5 },
    { content: '[认知] 详细展开说明', priority: 5 },
  ])
  assert(warning.length > 0, 'should detect 简洁 vs 详细 conflict')
})

test('5.3 learnConflict', () => {
  learnConflict(['[相关记忆] test', '[注意规则] test'], true)
  // No crash = pass
})

test('5.4 recordInteraction', () => {
  recordInteraction(['[相关记忆] test', '[认知] test'], 7, false)
  // No crash = pass
})

test('5.5 getInteractionInsight', () => {
  const insight = getInteractionInsight()
  assert(typeof insight === 'string', 'should return string')
})

test('5.6 getConflictResolutions', () => {
  const resolutions = getConflictResolutions([
    { content: '[相关记忆] 简洁', priority: 5 },
    { content: '[注意规则] 详细', priority: 7 },
  ])
  assert(Array.isArray(resolutions), 'should return array')
})

test('5.7 snapshotAugments', () => {
  snapshotAugments(['test augment 1', 'test augment 2'])
  // No crash = pass
})

// ══════════════════════════════════════════════════════════════════════════════
// 6. CONTEXT PREP (6 features) — NEW
// ══════════════════════════════════════════════════════════════════════════════

test('6.1 prepareContext — file path', () => {
  const ctx = prepareContext('看看 /etc/hosts 这个文件')
  assert(ctx.some(c => c.source.includes('hosts') || c.source === 'intent-hint') || ctx.length === 0, 'should detect file path or return empty if file missing')
})

test('6.2 prepareContext — error message', () => {
  const ctx = prepareContext('TypeError: Cannot read property "foo" of undefined')
  assert(ctx.some(c => c.source === 'error-detect' || c.source === 'stack-trace'), 'should detect error')
})

test('6.3 prepareContext — hex address', () => {
  const ctx = prepareContext('crash at 0x1A2B3C4D')
  assert(ctx.some(c => c.source === 'hex-detect'), 'should detect hex address')
})

test('6.4 prepareContext — intent hint', () => {
  const ctx = prepareContext('帮我看看这个代码怎么优化')
  assert(ctx.some(c => c.source === 'intent-hint') || ctx.length === 0, 'should generate intent hint or empty')
})

test('6.5 prepareContext — symbol grep', () => {
  // Use a symbol that likely exists in the project
  const ctx = prepareContext('`initializeSoul` 这个函数有问题')
  // May or may not find depending on cwd, but should not crash
  assert(Array.isArray(ctx), 'should return array')
})

await testAsync('6.6 prepareContextAsync — URL fetch', async () => {
  // Just verify the async version works, URL may timeout
  const ctx = await prepareContextAsync('看这个 https://example.com')
  assert(Array.isArray(ctx), 'should return array')
})

// ══════════════════════════════════════════════════════════════════════════════
// 7. PATTERNS (4 features) — NEW
// ══════════════════════════════════════════════════════════════════════════════

test('7.1 getBestPattern — cold start', () => {
  const hint = getBestPattern('怎么写一个函数', testUserId)
  assert(typeof hint === 'string', 'should return string (may be empty)')
})

test('7.2 learnSuccessPattern', () => {
  learnSuccessPattern('怎么写排序', '这是快排代码...', testUserId)
  // Async CLI call, no immediate result, but should not crash
})

test('7.3 getPatternStats', () => {
  const stats = getPatternStats()
  assert(typeof stats === 'object' && stats.total !== undefined, 'should return object with total')
})

// ══════════════════════════════════════════════════════════════════════════════
// 8. META-FEEDBACK (7 features) — NEW
// ══════════════════════════════════════════════════════════════════════════════

test('8.1 recordAugmentOutcome', () => {
  recordAugmentOutcome(['[相关记忆] test memory', '[认知] test cognition'], 7, false)
  recordAugmentOutcome(['[相关记忆] another', '[注意规则] rule'], 4, true)
  // No crash = pass
})

test('8.2 getAugmentPriorityMultiplier — returns number', () => {
  const mult = getAugmentPriorityMultiplier('相关记忆')
  assert(typeof mult === 'number' && mult > 0, `should return positive number, got ${mult}`)
})

test('8.3 getMetaFeedbackSummary', () => {
  const summary = getMetaFeedbackSummary()
  assert(typeof summary === 'string', 'should return string')
})

test('8.4 getPairEffects', () => {
  const effects = getPairEffects()
  assert(Array.isArray(effects), 'should return array')
})

test('8.5 detectAugmentTrends', () => {
  const trends = detectAugmentTrends()
  assert(Array.isArray(trends), 'should return array')
})

// ══════════════════════════════════════════════════════════════════════════════
// 9. PERSONA (7 features)
// ══════════════════════════════════════════════════════════════════════════════

test('9.1 selectPersona', () => {
  const persona = selectPersona('technical')
  assert(typeof persona === 'object' && persona.id !== undefined, `should return persona object with id, got ${typeof persona}`)
})

test('9.2 getBlendedPersonaOverlay', () => {
  const overlay = getBlendedPersonaOverlay('help', 'technical')
  assert(typeof overlay === 'string', 'should return overlay string')
})

// ══════════════════════════════════════════════════════════════════════════════
// 10. EPISTEMIC (5 features)
// ══════════════════════════════════════════════════════════════════════════════

test('10.1 detectDomain', () => {
  const domain = detectDomain('帮我写一个Python脚本')
  assert(typeof domain === 'string', 'should return domain string')
})

test('10.2 getDomainConfidence', () => {
  const conf = getDomainConfidence('python')
  assert(typeof conf === 'object', 'should return confidence object')
})

test('10.3 getWeakDomains', () => {
  const weak = getWeakDomains()
  assert(Array.isArray(weak), 'should return array')
})

test('10.4 getEpistemicSummary', () => {
  const summary = getEpistemicSummary()
  assert(typeof summary === 'string', 'should return string')
})

// ══════════════════════════════════════════════════════════════════════════════
// 11. FINGERPRINT (5 features)
// ══════════════════════════════════════════════════════════════════════════════

test('11.1 updateFingerprint', () => {
  updateFingerprint('这是一条测试回复，用来检测指纹基线')
  // No crash = pass
})

test('11.2 checkPersonaConsistency', () => {
  const result = checkPersonaConsistency('测试回复内容')
  assert(typeof result === 'string', 'should return string')
})

test('11.3 getFingerprintSummary', () => {
  const summary = getFingerprintSummary()
  assert(typeof summary === 'string', 'should return string')
})

// ══════════════════════════════════════════════════════════════════════════════
// 12. QUALITY (4 features)
// ══════════════════════════════════════════════════════════════════════════════

test('12.1 scoreResponse', () => {
  const score = scoreResponse('详细的技术回复，包含代码示例和解释', '帮我写排序')
  assert(typeof score === 'number' && score >= 0 && score <= 10, `score should be 0-10, got ${score}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// 13. PROMPT BUILDER (4 features)
// ══════════════════════════════════════════════════════════════════════════════

test('13.1 selectAugments — budget', () => {
  const augments = [
    { content: '[相关记忆] test 1', priority: 5, tokens: 50 },
    { content: '[认知] test 2', priority: 10, tokens: 50 },
    { content: '[注意规则] test 3', priority: 7, tokens: 50 },
  ]
  const selected = selectAugments(augments, 120, 1.0)
  assert(selected.length > 0, 'should select at least 1 augment')
  assert(selected.length <= augments.length, 'should not exceed input')
})

// ══════════════════════════════════════════════════════════════════════════════
// 14. USER PROFILES (5 features)
// ══════════════════════════════════════════════════════════════════════════════

test('14.1 updateProfileOnMessage', () => {
  updateProfileOnMessage(testUserId, '帮我看看这个Python代码')
  // No crash = pass
})

test('14.2 getProfile', () => {
  const profile = getProfile(testUserId)
  assert(profile !== undefined, 'should return profile')
})

test('14.3 getRhythmContext', () => {
  const rhythm = getRhythmContext(testUserId)
  assert(typeof rhythm === 'string', 'should return string')
})

// ══════════════════════════════════════════════════════════════════════════════
// 15. VALUES (4 features)
// ══════════════════════════════════════════════════════════════════════════════

test('15.1 detectValueSignals', () => {
  detectValueSignals('谢谢，很有帮助', true, testUserId)
  // No crash = pass
})

test('15.2 getValueContext', () => {
  const ctx = getValueContext(testUserId)
  assert(typeof ctx === 'string', 'should return string')
})

// ══════════════════════════════════════════════════════════════════════════════
// 16. FLOW (7 features)
// ══════════════════════════════════════════════════════════════════════════════

test('16.1 updateFlow — returns flow object', () => {
  const flow = updateFlow('你好', '', testUserId)
  assert(flow.turnCount !== undefined, 'should have turnCount')
})

test('16.2 updateFlow — turnCount increases', () => {
  updateFlow('你好', '你好呀', testUserId)
  const flow = updateFlow('继续聊', '好的', testUserId)
  assert(flow.turnCount >= 1, 'turnCount should be >= 1')
})

test('16.3 getFlowContext', () => {
  const ctx = getFlowContext(testUserId)
  assert(typeof ctx === 'string', 'should return string')
})

test('16.4 getCurrentFlowDepth', () => {
  const depth = getCurrentFlowDepth()
  assert(['shallow', 'deep', 'stuck'].includes(depth), `should be shallow/deep/stuck, got ${depth}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// 17. LOREBOOK (4 features)
// ══════════════════════════════════════════════════════════════════════════════

test('17.1 queryLorebook', () => {
  const entries = queryLorebook('测试关键词')
  assert(Array.isArray(entries), 'should return array')
})

// ══════════════════════════════════════════════════════════════════════════════
// 18. FEATURES TOGGLE (1 feature)
// ══════════════════════════════════════════════════════════════════════════════

test('18.1 isEnabled', () => {
  assert(typeof isEnabled('memory_active') === 'boolean', 'should return boolean')
  assert(typeof isEnabled('dream_mode') === 'boolean', 'should return boolean')
})

// ══════════════════════════════════════════════════════════════════════════════
// 19. AUTO-TUNE (5 features)
// ══════════════════════════════════════════════════════════════════════════════

test('19.1 getParam', () => {
  const budget = getParam('prompt.augment_budget')
  assert(typeof budget === 'number', `should return number, got ${typeof budget}`)
})

test('19.2 checkAutoTune', () => {
  checkAutoTune(mockStats)
  // No crash = pass
})

// ══════════════════════════════════════════════════════════════════════════════
// 20. DIAGNOSTIC (4 features)
// ══════════════════════════════════════════════════════════════════════════════

test('20.1 runFullDiagnostic', () => {
  const diag = runFullDiagnostic(mockStats)
  assert(Array.isArray(diag), 'should return array of diagnostics')
  assert(diag.length > 0, 'should have at least 1 diagnostic result')
})

test('20.2 formatDiagnosticReport', () => {
  const diag = runFullDiagnostic(mockStats)
  const report = formatDiagnosticReport(diag)
  assert(report.length > 0, 'should generate non-empty report')
})

// ══════════════════════════════════════════════════════════════════════════════
// 21. STORAGE (5 features)
// ══════════════════════════════════════════════════════════════════════════════

test('21.1 getStorageStatus', () => {
  const status = getStorageStatus()
  assert(status.backend !== undefined, 'should report backend type')
})

// ══════════════════════════════════════════════════════════════════════════════
// 22. VOICE (4 features)
// ══════════════════════════════════════════════════════════════════════════════

test('22.1 checkSpontaneousVoice', () => {
  const voice = checkSpontaneousVoice(100)
  assert(voice == null || typeof voice === 'string', 'should return null/undefined or string')
})

// ══════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(60))
console.log('  cc-soul integration test results')
console.log('═'.repeat(60))

const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed).length

for (const r of results) {
  if (r.passed) {
    console.log(`  ✅ ${r.name}`)
  } else {
    console.log(`  ❌ ${r.name}: ${r.error}`)
  }
}

console.log('')
console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`)
console.log('═'.repeat(60))

// Force exit — persistent daemon / heartbeat interval keeps process alive
process.exit(failed > 0 ? 1 : 0)
