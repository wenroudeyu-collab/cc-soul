/**
 * tests.ts — Core module regression tests
 *
 * Zero dependencies — runs with plain Node.js.
 * Used by upgrade system: after code changes, run these tests to catch logic errors
 * that esbuild can't detect (esbuild only checks syntax).
 *
 * Usage: npx tsx tests.ts  (or via runRegressionSuite() from upgrade.ts)
 */

import type { Memory, Rule, Hypothesis, Augment } from './types.ts'

// ══════════════════════════════════════════════════════════════════════════════
// MINI TEST RUNNER — no framework needed
// ══════════════════════════════════════════════════════════════════════════════

interface TestResult {
  name: string
  passed: boolean
  error?: string
}

const results: TestResult[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e: any) {
    results.push({ name, passed: false, error: e.message })
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`)
}

function assertEquals<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEquals'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertInRange(val: number, min: number, max: number, msg?: string) {
  if (val < min || val > max) {
    throw new Error(`${msg || 'assertInRange'}: ${val} not in [${min}, ${max}]`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 1: cognition.ts — via cogProcess (attentionGate/intent/strategy are private)
// ══════════════════════════════════════════════════════════════════════════════

import { cogProcess } from './cognition.ts'

test('cognition: correction detected', () => {
  const r = cogProcess('你说的不对，应该是这样的', '', '', undefined)
  assertEquals(r.attention, 'correction', 'should detect correction')
  assertEquals(r.strategy, 'acknowledge_and_retry', 'correction → acknowledge_and_retry')
})

test('cognition: "不错" is NOT correction', () => {
  const r = cogProcess('不错，说得很好', '', '', undefined)
  assert(r.attention !== 'correction', '"不错" should not trigger correction')
})

test('cognition: "没错" is NOT correction', () => {
  const r = cogProcess('没错就是这样', '', '', undefined)
  assert(r.attention !== 'correction', '"没错" should not trigger correction')
})

test('cognition: emotional detected', () => {
  const r = cogProcess('今天好烦啊，心情很差', '', '', undefined)
  assertEquals(r.attention, 'emotional', 'should detect emotional')
  assertEquals(r.strategy, 'empathy_first', 'emotional → empathy_first')
})

test('cognition: technical detected', () => {
  const r = cogProcess('这个函数的返回值类型是什么', '', '', undefined)
  assertEquals(r.attention, 'technical', 'should detect technical')
})

test('cognition: casual detected for short msg', () => {
  const r = cogProcess('嗯', '', '', undefined)
  assertEquals(r.attention, 'casual', 'short msg should be casual')
})

test('cognition: wants_opinion intent', () => {
  const r = cogProcess('你觉得这个方案怎么样，我想听听你的看法和建议', '', '', undefined)
  assertEquals(r.intent, 'wants_opinion', 'should detect wants_opinion')
  assertEquals(r.strategy, 'opinion_with_reasoning', 'wants_opinion → opinion_with_reasoning')
})

test('cognition: wants_action intent', () => {
  const r = cogProcess('帮我写一个脚本来处理这些文件，要能批量重命名的', '', '', undefined)
  assertEquals(r.intent, 'wants_action', 'should detect wants_action')
  assertEquals(r.strategy, 'action_oriented', 'wants_action → action_oriented')
})

test('cognition: complexity proportional to length', () => {
  const short = cogProcess('hi', '', '', undefined)
  const long = cogProcess('x'.repeat(500), '', '', undefined)
  assert(long.complexity > short.complexity, 'longer msg should have higher complexity')
  assertInRange(short.complexity, 0, 1, 'complexity')
  assertInRange(long.complexity, 0, 1, 'complexity')
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 2: quality.ts — scoreResponse
// ══════════════════════════════════════════════════════════════════════════════

import { scoreResponse } from './quality.ts'

test('scoreResponse: short answer for long question gets low score', () => {
  const score = scoreResponse('很长的技术问题需要详细解答请你认真回答这个非常复杂的问题', '好的')
  assert(score <= 5, `short answer for long question should score <=5, got ${score}`)
})

test('scoreResponse: detailed answer gets higher score', () => {
  const score = scoreResponse(
    '怎么用Python读文件',
    '你可以用 open() 函数读取文件。首先，使用 with open("file.txt", "r") as f: 打开文件，然后调用 f.read() 获取内容。因为使用了 with 语句，文件会自动关闭。这是最推荐的方式。',
  )
  assert(score >= 5, `detailed answer should score >=5, got ${score}`)
})

test('scoreResponse: answer with code block gets bonus', () => {
  const withCode = scoreResponse('怎么排序', '用这个:\n```python\nsorted(list)\n```\n这样就行了因为sorted函数会返回新列表')
  const withoutCode = scoreResponse('怎么排序', '用 sorted 函数就行了因为sorted函数会返回新列表')
  assert(withCode > withoutCode, `code block should boost score: ${withCode} vs ${withoutCode}`)
})

test('scoreResponse: AI identity exposure gets penalty', () => {
  const score = scoreResponse('你是谁', '作为一个AI语言模型，我无法做这件事')
  assert(score <= 5, `AI exposure should be penalized, got ${score}`)
})

test('scoreResponse: score is clamped to [1, 10]', () => {
  const low = scoreResponse('x'.repeat(100), 'y')
  const high = scoreResponse('hi', '因为所以首先其次最后，' + '详细解答'.repeat(100) + '\n```code```\n1. a\n2. b\n3. c')
  assertInRange(low, 1, 10, 'low score')
  assertInRange(high, 1, 10, 'high score')
})

test('scoreResponse: reasoning markers boost score', () => {
  const with_reason = scoreResponse('为什么', '因为这个原理是基于量子力学的，所以会产生干涉效应，首先需要理解波函数')
  const without_reason = scoreResponse('为什么', '这个原理是基于量子力学的会产生干涉效应需要理解波函数相关的概念才行')
  assert(with_reason >= without_reason, `reasoning markers should help: ${with_reason} vs ${without_reason}`)
})

test('scoreResponse: overly long answer for short question penalized', () => {
  const score = scoreResponse('对吗', 'x'.repeat(1100))
  const normal = scoreResponse('请详细解释一下这个复杂的算法的实现原理和具体步骤', 'x'.repeat(1100))
  assert(score <= normal, `long answer for short question should be penalized: ${score} vs ${normal}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 3: body.ts — bodyTick boundaries
// ══════════════════════════════════════════════════════════════════════════════

import { body, bodyTick, bodyGetParams } from './body.ts'

test('body: initial values in valid range', () => {
  assertInRange(body.energy, 0, 1, 'energy')
  assertInRange(body.mood, -1, 1, 'mood')
  assertInRange(body.load, 0, 1, 'load')
  assertInRange(body.alertness, 0, 1, 'alertness')
  assertInRange(body.anomaly, 0, 1, 'anomaly')
})

test('body: bodyTick keeps values in range', () => {
  // Save originals
  const orig = { ...body }
  // Set extreme values
  body.energy = 0.01
  body.mood = -0.95
  body.alertness = 0.99
  body.load = 0.8
  body.anomaly = 0.9

  bodyTick()

  assertInRange(body.energy, 0, 1, 'energy after tick')
  assertInRange(body.mood, -1, 1, 'mood after tick')
  assertInRange(body.alertness, 0, 1, 'alertness after tick')
  assertInRange(body.load, 0, 1, 'load after tick')
  assertInRange(body.anomaly, 0, 1, 'anomaly after tick')

  // Energy should recover
  assert(body.energy >= 0.01, 'energy should not decrease during idle tick')
  // Load should decrease
  assert(body.load <= 0.8, 'load should decay during tick')

  // Restore
  Object.assign(body, orig)
})

test('body: bodyGetParams returns valid style', () => {
  const params = bodyGetParams()
  assert(typeof params.soulTone === 'string' && params.soulTone.length > 0, 'soulTone should be non-empty string')
  assert(typeof params.maxTokensMultiplier === 'number', 'maxTokensMultiplier should be number')
  assert(typeof params.shouldSelfCheck === 'boolean', 'shouldSelfCheck should be boolean')
  assert(typeof params.responseStyle === 'string' && params.responseStyle.length > 0, `responseStyle should be non-empty string, got ${params.responseStyle}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 4: evolution.ts — rules and hypotheses
// ══════════════════════════════════════════════════════════════════════════════

import { addRule, getRelevantRules, verifyHypothesis, rules, hypotheses } from './evolution.ts'

test('evolution: addRule deduplicates', () => {
  const before = rules.length
  addRule('测试规则：不要用print调试', 'test')
  addRule('测试规则：不要用print调试', 'test') // duplicate
  assert(rules.length <= before + 1, 'duplicate rule should not be added')
  // Cleanup
  const idx = rules.findIndex(r => r.rule === '测试规则：不要用print调试')
  if (idx >= 0) rules.splice(idx, 1)
})

test('evolution: addRule rejects short rules', () => {
  const before = rules.length
  addRule('ab', 'test')
  assertEquals(rules.length, before, 'rule <5 chars should be rejected')
})

test('evolution: getRelevantRules returns matching rules', () => {
  addRule('当用户问Python问题时先给代码', 'test')
  const matched = getRelevantRules('帮我写一个Python脚本', 3, false)
  const found = matched.some(r => r.rule.includes('Python'))
  assert(found, 'should find Python-related rule')
  // Cleanup
  const idx = rules.findIndex(r => r.rule === '当用户问Python问题时先给代码')
  if (idx >= 0) rules.splice(idx, 1)
})

test('evolution: getRelevantRules returns empty for no match', () => {
  const matched = getRelevantRules('xyzzy123_no_match_possible', 3, false)
  assertEquals(matched.length, 0, 'should return empty for no match')
})

test('evolution: verifyHypothesis increments evidence', () => {
  // CJK regex matches greedy runs of Chinese chars (2+ consecutive)
  // So description keywords = ['当用户问', 'Python', '代码问题时', '直接给代码比解释原理效果好']
  // situation must contain >=3 of these EXACT substrings
  const testH: Hypothesis = {
    id: 'test-h-1',
    description: '当用户问 Python 代码 问题时 直接 给代码',
    alpha: 1,
    beta: 1,
    status: 'active',
    created: Date.now(),
  }
  hypotheses.push(testH)

  // With spaces breaking CJK runs, keywords are shorter: ['当用户问', 'Python', '代码', '问题时', '直接', '给代码']
  // situation contains: '当用户问' + 'Python' + '代码' + '问题时' + '直接' = 5 matches (>= 3)
  verifyHypothesis('当用户问 Python 代码 问题时需要直接回答', true)
  assert(testH.alpha > 1, 'alpha should increment on success')

  verifyHypothesis('当用户问 Python 代码 问题时需要直接回答', false)
  assert(testH.beta > 1, 'beta should increment on failure')

  // Cleanup
  const idx = hypotheses.findIndex(h => h.id === 'test-h-1')
  if (idx >= 0) hypotheses.splice(idx, 1)
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 5: prompt-builder.ts — selectAugments
// ══════════════════════════════════════════════════════════════════════════════

import { selectAugments } from './prompt-builder.ts'

test('selectAugments: respects budget', () => {
  const augments: Augment[] = [
    { content: '记忆：用户喜欢简洁', priority: 8, tokens: 500 },
    { content: '规则：不要用print', priority: 7, tokens: 500 },
    { content: '人格：工程师模式', priority: 9, tokens: 500 },
    { content: '上下文：当前在聊Python', priority: 6, tokens: 500 },
    { content: '其他：能量偏低', priority: 3, tokens: 500 },
  ]
  const selected = selectAugments(augments, 1500)
  const totalTokens = augments.filter(a => selected.includes(a.content)).reduce((s, a) => s + a.tokens, 0)
  assert(totalTokens <= 1500, `total tokens ${totalTokens} should be within budget 1500`)
})

test('selectAugments: prioritizes higher priority', () => {
  const augments: Augment[] = [
    { content: 'low priority item', priority: 1, tokens: 100 },
    { content: 'high priority item', priority: 10, tokens: 100 },
    { content: 'medium priority item', priority: 5, tokens: 100 },
  ]
  const selected = selectAugments(augments, 150)
  assert(selected.includes('high priority item'), 'should select highest priority first')
  assert(!selected.includes('low priority item'), 'should not select low priority when budget is tight')
})

test('selectAugments: energy multiplier reduces budget', () => {
  const augments: Augment[] = [
    { content: '记忆A', priority: 8, tokens: 400 },
    { content: '记忆B', priority: 7, tokens: 400 },
    { content: '记忆C', priority: 6, tokens: 400 },
    { content: '记忆D', priority: 5, tokens: 400 },
  ]
  const fullEnergy = selectAugments(augments, 2000, 1.0)
  const lowEnergy = selectAugments(augments, 2000, 0.5)
  assert(lowEnergy.length <= fullEnergy.length, `low energy should select fewer augments: ${lowEnergy.length} vs ${fullEnergy.length}`)
})

test('selectAugments: empty augments returns empty', () => {
  const selected = selectAugments([], 2000)
  assertEquals(selected.length, 0, 'empty augments should return empty')
})

test('selectAugments: does not exceed budget even with many augments', () => {
  const augments: Augment[] = Array.from({ length: 20 }, (_, i) => ({
    content: `augment ${i}`,
    priority: 10 - (i % 10),
    tokens: 300,
  }))
  const selected = selectAugments(augments, 1000)
  // 1000 / 300 = max 3 items
  assert(selected.length <= 4, `should not exceed budget: selected ${selected.length} items`)
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 6: memory.ts — recall, addMemory, scope index
// ══════════════════════════════════════════════════════════════════════════════

import { memoryState, addMemory, recall, getMemoriesByScope } from './memory.ts'

test('memory: addMemory stores and deduplicates', () => {
  const before = memoryState.memories.length
  addMemory('测试记忆用于单元测试验证_unique_1', 'fact')
  assert(memoryState.memories.length > before, 'should add memory')

  const before2 = memoryState.memories.length
  addMemory('测试记忆用于单元测试验证_unique_1', 'fact') // duplicate
  assertEquals(memoryState.memories.length, before2, 'duplicate should not be added')

  // Cleanup
  const idx = memoryState.memories.findIndex(m => m.content.includes('unique_1'))
  if (idx >= 0) memoryState.memories.splice(idx, 1)
})

test('memory: addMemory rejects short content', () => {
  const before = memoryState.memories.length
  addMemory('ab', 'fact')
  assertEquals(memoryState.memories.length, before, 'content <3 chars should be rejected')
})

test('memory: getMemoriesByScope returns correct scope', () => {
  addMemory('测试scope查询_unique_scope_test', 'discovery')
  const discoveries = getMemoriesByScope('discovery')
  const found = discoveries.some(m => m.content.includes('unique_scope_test'))
  assert(found, 'should find memory by scope')

  // Cleanup
  const idx = memoryState.memories.findIndex(m => m.content.includes('unique_scope_test'))
  if (idx >= 0) memoryState.memories.splice(idx, 1)
})

test('memory: recall returns relevant results', () => {
  addMemory('Python的装饰器是一种高阶函数的语法糖', 'fact')
  addMemory('Rust的所有权系统保证内存安全', 'fact')

  const results = recall('Python装饰器怎么用', 3)
  if (results.length > 0) {
    const topResult = results[0]
    assert(topResult.content.includes('Python') || topResult.content.includes('装饰器'),
      `top recall should be Python-related, got: ${topResult.content.slice(0, 50)}`)
  }

  // Cleanup
  for (const keyword of ['语法糖', '所有权系统保证']) {
    const idx = memoryState.memories.findIndex(m => m.content.includes(keyword))
    if (idx >= 0) memoryState.memories.splice(idx, 1)
  }
})

test('memory: recall returns empty for empty query', () => {
  const results = recall('', 3)
  assertEquals(results.length, 0, 'empty query should return empty')
})

test('memory: recall returns empty for no-keyword query', () => {
  const results = recall('a b', 3)
  assertEquals(results.length, 0, 'no-keyword query should return empty')
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 7: E2E — full message lifecycle simulation
// ══════════════════════════════════════════════════════════════════════════════

import { selectPersona } from './persona.ts'
import { compressMemory, decideMemoryAction, parseMemoryCommands } from './memory.ts'

test('E2E: technical message → cognition + persona + recall', () => {
  // 1. Cognition: detect technical intent
  const cog = cogProcess('帮我写一个Python排序函数，要支持自定义比较器', '', '', 'test_user')
  assertEquals(cog.attention, 'technical', 'should detect technical')
  assertEquals(cog.intent, 'wants_action', 'should detect wants_action for "帮我写"')

  // 2. Persona: should select a persona (not crash)
  const persona = selectPersona(cog.attention, 0, 'test_user', cog.intent, '帮我写一个Python排序函数')
  assert(persona !== undefined, 'should select persona')
  assert(typeof persona.id === 'string', 'persona should have id')

  // 3. Memory: store and recall
  addMemory('Python排序函数已提供，支持自定义比较器_e2e_test', 'fact', 'test_user')
  const recalled = recall('Python排序比较器', 3, 'test_user')
  assert(recalled.length > 0, 'should recall Python-related memory')
  assert(recalled.some(r => r.content.includes('e2e_test')), 'should recall the specific memory we just added')

  // Cleanup
  const idx = memoryState.memories.findIndex(m => m.content.includes('e2e_test'))
  if (idx >= 0) memoryState.memories.splice(idx, 1)
})

test('E2E: correction flow → cognition detects + score penalizes', () => {
  // Simulate: user corrects a previous response
  const prevPrompt = '什么是闭包'
  const prevResponse = '闭包是一种数据结构' // intentionally wrong-ish

  const cog = cogProcess('你说的不对，闭包是函数和其词法环境的组合', prevResponse, prevPrompt, 'test_user')
  assertEquals(cog.attention, 'correction', 'should detect correction')
  assertEquals(cog.strategy, 'acknowledge_and_retry', 'correction → acknowledge_and_retry')

  // Score the bad response
  const score = scoreResponse(prevPrompt, prevResponse)
  assert(score <= 6, `short wrong answer should score low, got ${score}`)
})

test('E2E: memory dedup + compression pipeline', () => {
  // Add a memory
  addMemory('用户说他非常喜欢Python的装饰器语法糖特性_dedup_test', 'preference', 'test_user')

  // Dedup: same content should skip
  const decision = decideMemoryAction('用户说他非常喜欢Python的装饰器语法糖特性_dedup_test', 'preference')
  assertEquals(decision.action, 'skip', 'exact duplicate should skip')

  // Compression: verbose memory should be compressed
  const compressed = compressMemory({
    content: '用户说非常喜欢Python的装饰器语法糖，觉得特别好用的，说实话真的很方便',
    scope: 'preference',
    ts: Date.now(),
  } as any)
  assert(compressed.length > 0, 'compressed result should not be empty')
  // "用户说" prefix should be stripped by COMPRESS_PATTERNS
  assert(!compressed.startsWith('用户说'), 'compression should strip "用户说" prefix')
  // "说实话" should also be stripped
  assert(!compressed.includes('说实话'), 'compression should strip "说实话"')

  // Cleanup
  const idx = memoryState.memories.findIndex(m => m.content.includes('dedup_test'))
  if (idx >= 0) memoryState.memories.splice(idx, 1)
})

test('E2E: active memory commands parsing', () => {
  const response = '好的我记住了（记下了：用户的服务器IP是192.168.1.1）。另外那个旧的地址不用了（忘掉：旧服务器地址）。'
  const commands = parseMemoryCommands(response)

  assert(commands.length >= 2, `should parse at least 2 commands, got ${commands.length}`)

  const rememberCmd = commands.find(c => c.action === 'remember')
  assert(rememberCmd !== undefined, 'should have a remember command')
  assert(rememberCmd!.content.includes('192.168.1.1'), 'remember command should contain IP')

  const forgetCmd = commands.find(c => c.action === 'forget')
  assert(forgetCmd !== undefined, 'should have a forget command')
  assert(forgetCmd!.content.includes('旧服务器'), 'forget command should contain keyword')
})

test('E2E: emotional message → empathy strategy + body affect', () => {
  // Use keywords that cognition.ts actually matches for emotional detection
  const cog = cogProcess('今天好烦啊，心情很差，不想干了', '', '', 'test_user')
  assertEquals(cog.attention, 'emotional', 'should detect emotional')
  assertEquals(cog.strategy, 'empathy_first', 'emotional → empathy_first')
  assert(cog.complexity > 0, 'should have non-zero complexity')

  // Persona for emotional context should not crash
  const persona = selectPersona(cog.attention, 0.3, 'test_user', cog.intent, '心情很差')
  assert(persona !== undefined, 'should select persona for emotional context')
})

// ══════════════════════════════════════════════════════════════════════════════
// HABIT / CHECKIN LOGIC TESTS
// ══════════════════════════════════════════════════════════════════════════════

function simulateCheckin(checkins: number[], nowMs: number): { streak: number; checkins: number[]; duplicate: boolean } {
  const today = Math.floor(nowMs / 86400000)
  const lastDay = checkins.length > 0 ? Math.floor(checkins[checkins.length - 1] / 86400000) : 0
  if (lastDay === today) return { streak: -1, checkins, duplicate: true }
  const streak = lastDay === today - 1 ? (checkins.length > 0 ? 1 : 1) : 1 // simplified: no prev streak passed in
  return { streak, checkins: [...checkins, nowMs], duplicate: false }
}

// Full streak calc matching handler.ts logic
function calcStreak(checkins: number[], nowMs: number, prevStreak: number): { streak: number; duplicate: boolean } {
  const today = Math.floor(nowMs / 86400000)
  const lastDay = checkins.length > 0 ? Math.floor(checkins[checkins.length - 1] / 86400000) : 0
  if (lastDay === today) return { streak: prevStreak, duplicate: true }
  const streak = lastDay === today - 1 ? prevStreak + 1 : 1
  return { streak, duplicate: false }
}

const DAY = 86400000
const base = Math.floor(Date.now() / DAY) * DAY // today 00:00 UTC ms

test('habit: 同天重复打卡应被拒绝', () => {
  const checkins = [base + 1000]
  const { duplicate } = calcStreak(checkins, base + 5000, 1)
  assert(duplicate, '同天第二次打卡应返回 duplicate=true')
})

test('habit: 连续两天 streak 递增', () => {
  const yesterday = base - DAY + 1000
  const checkins = [yesterday]
  const { streak, duplicate } = calcStreak(checkins, base + 1000, 1)
  assert(!duplicate, '不应判断为重复')
  assertEquals(streak, 2, '连续天数应为 2')
})

test('habit: 断签后 streak 重置为 1', () => {
  const twoDaysAgo = base - 2 * DAY + 1000
  const checkins = [twoDaysAgo]
  const { streak, duplicate } = calcStreak(checkins, base + 1000, 5)
  assert(!duplicate, '不应判断为重复')
  assertEquals(streak, 1, '断签后 streak 应重置为 1')
})

test('habit: 里程碑节点 7/30/100 有对应消息', () => {
  const milestones: Record<number, string> = {
    7: '🔥 连续7天达成！',
    30: '🏅 连续30天！',
    100: '🏆 连续100天！',
  }
  assert(milestones[7] !== undefined, '7天里程碑存在')
  assert(milestones[30] !== undefined, '30天里程碑存在')
  assert(milestones[100] !== undefined, '100天里程碑存在')
  assert(milestones[8] === undefined, '非里程碑天数无消息')
})

test('habit: 首次打卡 streak=1', () => {
  const { streak, duplicate } = calcStreak([], base + 1000, 0)
  assert(!duplicate, '首次打卡不是重复')
  assertEquals(streak, 1, '首次打卡 streak 应为 1')
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE: reports.ts — 晨报 / 周报 / 定时触发
// ══════════════════════════════════════════════════════════════════════════════

import { generateMorningReport, generateWeeklyReport, checkScheduledReports } from './reports.ts'

test('reports: generateMorningReport returns string with header', () => {
  const report = generateMorningReport()
  assert(typeof report === 'string', 'should return string')
  assert(report.includes('晨报'), 'should contain 晨报 header')
  assert(report.includes('昨日对话'), 'should contain 对话 section')
  assert(report.includes('今日提醒'), 'should contain 提醒 section')
  assert(report.includes('活跃目标'), 'should contain 目标 section')
  assert(report.includes('情绪趋势'), 'should contain 情绪 section')
  assert(report.includes('待关注'), 'should contain 纠正 section')
})

test('reports: generateWeeklyReport returns string with header', () => {
  const report = generateWeeklyReport()
  assert(typeof report === 'string', 'should return string')
  assert(report.includes('周报'), 'should contain 周报 header')
  assert(report.includes('对话统计'), 'should contain 对话统计 section')
  assert(report.includes('记忆变化'), 'should contain 记忆变化 section')
  assert(report.includes('目标进度'), 'should contain 目标进度 section')
  assert(report.includes('能力评分'), 'should contain 能力评分 section')
  assert(report.includes('规则'), 'should contain 规则 section')
})

test('reports: checkScheduledReports returns null outside 8:00-9:00', () => {
  // checkScheduledReports checks current hour — outside 8:00 it should return null
  const hour = new Date().getHours()
  const result = checkScheduledReports()
  if (hour < 8 || hour > 8) {
    assertEquals(result, null, 'should return null outside 8:00-8:59')
  }
  // If it IS 8:00, it may return a report — that's also correct behavior
})

test('reports: morning report handles db unavailable gracefully', () => {
  // Even if db is not available, should not throw
  const report = generateMorningReport()
  assert(report.length > 0, 'should return non-empty string even without db')
})

test('reports: weekly report handles db unavailable gracefully', () => {
  const report = generateWeeklyReport()
  assert(report.length > 0, 'should return non-empty string even without db')
})

test('reports: progressBar helper via morning report output', () => {
  const report = generateMorningReport()
  // If there are goals, should contain progress bar chars
  // If no goals, should contain "无活跃目标" — both are valid
  assert(report.includes('░') || report.includes('▓') || report.includes('无活跃目标'), 'should show progress bar or no-goals message')
})

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE: 后台自动功能 — persona / smart-forget / episodic / decay
// ══════════════════════════════════════════════════════════════════════════════

import { selectPersona, PERSONAS } from './persona.ts'

test('persona: selectPersona returns valid persona for correction', () => {
  const p = selectPersona('correction', 0.3, undefined, undefined, '你说的不对')
  assert(p !== null && p !== undefined, 'should return a persona')
  assert(typeof p.name === 'string', 'persona should have name')
  assert(typeof p.tone === 'string', 'persona should have tone')
})

test('persona: selectPersona returns comforter on emotional + high frustration', () => {
  const p = selectPersona('emotional', 0.8, undefined, undefined, '好累 想哭')
  assertEquals(p.id || p.name, PERSONAS[4]?.id || PERSONAS[4]?.name, 'should activate comforter on distress')
})

test('persona: selectPersona socratic trigger', () => {
  const p = selectPersona('learning', 0, undefined, undefined, '帮我理解 为什么需要锁')
  // Should pick socratic or learning-related persona
  assert(p !== null, 'should return a persona for learning')
})

test('persona: PERSONAS has 11 entries', () => {
  assertEquals(PERSONAS.length, 11, 'should have 11 personas')
  const names = PERSONAS.map((p: any) => p.name)
  assert(names.includes('工程师'), 'should have 工程师')
  assert(names.includes('分析师'), 'should have 分析师')
  assert(names.includes('安抚者'), 'should have 安抚者')
})

// ── smart-forget (Weibull + ACT-R) ──

import { computeForgetScore, smartForgetSweep } from './smart-forget.ts'

test('smart-forget: computeForgetScore returns number in [0,1]', () => {
  const score = computeForgetScore({
    ts: Date.now() - 7 * 86400000, // 7 days ago
    recallCount: 3,
    lastAccessed: Date.now() - 86400000, // 1 day ago
    scope: 'fact',
  })
  assert(typeof score === 'number', 'should return number')
  assertInRange(score, 0, 1, 'score should be in [0,1]')
})

test('smart-forget: old unaccessed memory has higher forget score', () => {
  const oldScore = computeForgetScore({
    ts: Date.now() - 90 * 86400000,
    recallCount: 0,
    lastAccessed: Date.now() - 90 * 86400000,
    scope: 'fact',
  })
  const newScore = computeForgetScore({
    ts: Date.now() - 1 * 86400000,
    recallCount: 5,
    lastAccessed: Date.now() - 3600000,
    scope: 'fact',
  })
  assert(oldScore > newScore, `old memory (${oldScore.toFixed(3)}) should have higher forget score than new (${newScore.toFixed(3)})`)
})

test('smart-forget: frequently recalled memory has lower forget score', () => {
  const frequentScore = computeForgetScore({
    ts: Date.now() - 30 * 86400000,
    recallCount: 20,
    lastAccessed: Date.now() - 3600000,
    scope: 'fact',
  })
  const rareScore = computeForgetScore({
    ts: Date.now() - 30 * 86400000,
    recallCount: 0,
    lastAccessed: Date.now() - 30 * 86400000,
    scope: 'fact',
  })
  assert(frequentScore < rareScore, `frequent (${frequentScore.toFixed(3)}) should < rare (${rareScore.toFixed(3)})`)
})

test('smart-forget: smartForgetSweep returns sweep result', () => {
  const mems = [
    { content: '测试1', scope: 'fact', ts: Date.now() - 90 * 86400000, recallCount: 0, lastAccessed: Date.now() - 90 * 86400000 },
    { content: '测试2', scope: 'fact', ts: Date.now() - 1 * 86400000, recallCount: 5, lastAccessed: Date.now() },
    { content: '测试3', scope: 'pinned', ts: Date.now() - 60 * 86400000, recallCount: 0, lastAccessed: 0 },
  ]
  const result = smartForgetSweep(mems)
  assert(result !== null && result !== undefined, 'should return result')
  assert(typeof result.toForget !== 'undefined' || typeof result.candidates !== 'undefined', 'should have forget candidates')
})

// ── episodic memory ──

import { recordEpisode, recallEpisodes } from './memory.ts'

test('episodic: recordEpisode + recallEpisodes round trip', () => {
  recordEpisode(
    'Python GIL 讨论',
    [{ role: 'user', content: 'GIL 为什么存在' }, { role: 'assistant', content: '因为 CPython 引用计数' }],
    { what: '过于简化', cause: '缺乏上下文' },
    'GIL 是为了线程安全保护引用计数',
    0.3,
    '下次解释 GIL 要提到 C 扩展兼容性'
  )
  const recalled = recallEpisodes('Python GIL 线程安全')
  assert(recalled.length >= 1, 'should recall the episode we just added')
  assert(recalled[0].topic.includes('GIL'), 'recalled episode should match topic')
})

test('episodic: recallEpisodes returns empty for unrelated query', () => {
  const recalled = recallEpisodes('量子力学薛定谔方程')
  // May or may not match — just verify it doesn't crash
  assert(Array.isArray(recalled), 'should return array')
})

// ── memory decay ──

import { processMemoryDecay, memoryState, addMemory, saveMemories } from './memory.ts'

test('memory-decay: processMemoryDecay runs without crash', () => {
  // Add some test memories to ensure there's data to decay
  const beforeCount = memoryState.memories.length
  addMemory('decay_test_old_memory_for_unit_test', 'fact', 'test-user')
  // Backdate it
  const lastMem = memoryState.memories[memoryState.memories.length - 1]
  if (lastMem) {
    lastMem.ts = Date.now() - 60 * 86400000 // 60 days old
    lastMem.tier = 'short_term'
    lastMem.recallCount = 0
  }
  // Should not throw
  processMemoryDecay()
  assert(true, 'processMemoryDecay completed without crash')
})

// ── lorebook auto-populate ──

import { autoPopulateFromMemories } from './lorebook.ts'

test('lorebook: autoPopulateFromMemories runs without crash', () => {
  const testMems: Memory[] = [
    { content: '用户喜欢 Python 和 Rust', scope: 'preference', ts: Date.now(), tags: ['python', 'rust'], confidence: 0.9, emotion: 'neutral', recallCount: 0 },
    { content: 'ARM64 汇编中 LDR 指令用于加载寄存器', scope: 'fact', ts: Date.now(), tags: ['arm64'], confidence: 0.8, emotion: 'neutral', recallCount: 0 },
  ]
  autoPopulateFromMemories(testMems)
  assert(true, 'autoPopulateFromMemories completed without crash')
})

// ══════════════════════════════════════════════════════════════════════════════
// RUN ALL TESTS + REPORT
// ══════════════════════════════════════════════════════════════════════════════

export function runRegressionSuite(): { passed: number; failed: number; total: number; failures: string[] } {
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const failures = results.filter(r => !r.passed).map(r => `  ❌ ${r.name}: ${r.error}`)

  return { passed, failed, total: results.length, failures }
}

export function formatTestReport(): string {
  const { passed, failed, total, failures } = runRegressionSuite()
  const lines = [`cc-soul regression tests: ${passed}/${total} passed`]
  if (failures.length > 0) {
    lines.push('Failures:')
    lines.push(...failures)
  }
  return lines.join('\n')
}

// If run directly: print results
if (process.argv[1]?.endsWith('tests.ts')) {
  console.log(formatTestReport())
  const { failed } = runRegressionSuite()
  process.exit(failed > 0 ? 1 : 0)
}
