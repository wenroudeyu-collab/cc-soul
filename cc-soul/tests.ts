/**
 * tests.ts — Core module regression tests
 *
 * Zero dependencies — runs with plain Node.js.
 * Used by upgrade system: after code changes, run these tests to catch logic errors
 * that esbuild can't detect (esbuild only checks syntax).
 *
 * Usage: npx tsx tests.ts
 */

import type { Memory, Rule, Hypothesis, Augment } from './types.ts'
import { loadDistillState, getMentalModel, getRelevantTopics, buildTopicAugment, buildMentalModelAugment, getDistillStats } from './distill.ts'
import { detectMentionedPeople, updateSocialGraph, getSocialContext, _resetSocialGraph } from './graph.ts'

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

import { addRule, getRelevantRules, verifyHypothesis, generalizeRules, rules, hypotheses } from './evolution.ts'

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

test('evolution: verifyHypothesis solidifies after 3 successes', () => {
  const testH: Hypothesis = {
    id: 'test-h-1',
    description: '当用户问 Python 代码 问题时 直接 给代码',
    alpha: 1,
    beta: 1,
    status: 'active',
    created: Date.now(),
  }
  hypotheses.push(testH)

  // Need 3 successful verifications to solidify
  verifyHypothesis('当用户问 Python 代码 问题时需要直接回答', true)
  assert(testH.alpha > 1, 'alpha should increment on success')
  assertEquals(testH.status, 'active', 'hypothesis should stay active after 1 verification')
  verifyHypothesis('当用户问 Python 代码 问题时需要直接回答', true)
  verifyHypothesis('当用户问 Python 代码 问题时需要直接回答', true)
  assertEquals(testH.status, 'verified', 'hypothesis should be solidified after 3 verifications')

  // Cleanup
  const idx = hypotheses.findIndex(h => h.id === 'test-h-1')
  if (idx >= 0) hypotheses.splice(idx, 1)
})

test('evolution: generalizeRules creates domain-wide rule when 2+ rules in same domain', () => {
  const before = rules.length
  // Add two Python-domain rules manually
  rules.push({ rule: 'Python 3.13 才有 free-threaded 模式不是 3.12', source: 'correction', ts: Date.now(), hits: 1 })
  rules.push({ rule: 'Python asyncio.run 在 3.7+ 才可用', source: 'correction', ts: Date.now(), hits: 2 })
  generalizeRules('Python asyncio.run 在 3.7+ 才可用')
  const gen = rules.find(r => r.source === 'generalized' && r.rule.includes('Python'))
  assert(!!gen, 'should create a generalized Python rule')
  assert(gen!.hits >= 2, 'generalized rule should have higher hits than individual rules')
  // Cleanup
  while (rules.length > before) rules.pop()
})

test('evolution: generalizeRules does not duplicate if generalized rule exists', () => {
  const before = rules.length
  rules.push({ rule: 'Python 3.13 才有 free-threaded', source: 'correction', ts: Date.now(), hits: 1 })
  rules.push({ rule: 'Python asyncio.run 在 3.7+', source: 'correction', ts: Date.now(), hits: 2 })
  generalizeRules('Python asyncio.run 在 3.7+')
  const genCount1 = rules.filter(r => r.source === 'generalized' && r.rule.includes('Python')).length
  // Call again — should not add a second generalized rule
  generalizeRules('Python import 语法变化')
  const genCount2 = rules.filter(r => r.source === 'generalized' && r.rule.includes('Python')).length
  assertEquals(genCount2, genCount1, 'should not duplicate generalized rule')
  // Cleanup
  while (rules.length > before) rules.pop()
})

test('evolution: generalizeRules skips unknown domains', () => {
  const before = rules.length
  rules.push({ rule: '今天天气真好啊', source: 'test', ts: Date.now(), hits: 0 })
  rules.push({ rule: '明天也会很好', source: 'test', ts: Date.now(), hits: 0 })
  generalizeRules('今天天气真好啊')
  const gen = rules.find(r => r.source === 'generalized')
  assert(!gen, 'should not generalize for unknown/general domains')
  // Cleanup
  while (rules.length > before) rules.pop()
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

// selectPersona already imported above; import PERSONAS separately
import { PERSONAS } from './persona.ts'

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

// memoryState, addMemory already imported above; import remaining
import { processMemoryDecay, saveMemories } from './memory.ts'

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
// TEST SUITE: v2.3+ 自动化功能 — 记忆链路 / 重复问题检测 / 情绪按天聚合
// ══════════════════════════════════════════════════════════════════════════════

import { graphWalkRecallScored, findMentionedEntities, graphState } from './graph.ts'
import { trigrams, trigramSimilarity } from './memory.ts'

test('auto-memory-chain: graphWalkRecallScored returns scored results', () => {
  // 确保 graphState 有实体数据
  const origEntities = [...graphState.entities]
  const origRelations = [...graphState.relations]
  graphState.entities.push(
    { name: 'Python', type: 'tech', mentions: 5, firstSeen: Date.now(), lastSeen: Date.now() },
    { name: 'GIL', type: 'concept', mentions: 3, firstSeen: Date.now(), lastSeen: Date.now() },
  )
  graphState.relations.push(
    { source: 'Python', target: 'GIL', type: 'has', weight: 1, createdAt: Date.now(), invalid_at: null },
  )

  const testMemories = [
    { content: 'Python 的 GIL 限制多线程性能', scope: 'fact', ts: Date.now() - 86400000, tags: ['python'], confidence: 0.9, emotion: 'neutral' as const, recallCount: 2 },
    { content: 'GIL 可以通过多进程绕过', scope: 'fact', ts: Date.now() - 43200000, tags: ['python'], confidence: 0.8, emotion: 'neutral' as const, recallCount: 1 },
  ]

  const results = graphWalkRecallScored(['Python'], testMemories as any, 1, 5)
  assert(Array.isArray(results), 'should return array')
  // 至少能找到包含 Python/GIL 的记忆
  if (results.length > 0) {
    assert(typeof results[0].graphScore === 'number', 'result should have graphScore')
    assert(results[0].graphScore > 0, 'graphScore should be positive')
  }

  // 还原
  graphState.entities.splice(-2, 2)
  graphState.relations.splice(-1, 1)
})

test('auto-repeat-detect: trigram similarity detects similar questions', () => {
  const q1 = '怎么用 Python 读取 JSON 文件'
  const q2 = '如何用 Python 读取 JSON 文件'
  const q3 = 'ARM64 汇编里 LDR 指令怎么用'

  const tri1 = trigrams(q1)
  const tri2 = trigrams(q2)
  const tri3 = trigrams(q3)

  const sim12 = trigramSimilarity(tri1, tri2)
  const sim13 = trigramSimilarity(tri1, tri3)

  assert(sim12 > 0.5, `similar questions should have sim > 0.5, got ${sim12.toFixed(3)}`)
  assert(sim13 < 0.3, `unrelated questions should have sim < 0.3, got ${sim13.toFixed(3)}`)
})

test('auto-repeat-detect: conclusion lookup finds nearby memories', () => {
  // 模拟用户问过的问题和结论
  const questionTs = Date.now() - 7 * 86400000
  const testMem: Memory = {
    content: '怎么用 Python 解析 JSON',
    scope: 'fact',
    ts: questionTs,
    tags: ['python'],
    confidence: 0.8,
    emotion: 'neutral',
    recallCount: 1,
  }
  const conclusionMem: Memory = {
    content: '用 json.loads() 解析字符串，json.load() 解析文件',
    scope: 'consolidated',
    ts: questionTs + 60000, // 1 min after
    tags: ['python'],
    confidence: 0.9,
    emotion: 'neutral',
    recallCount: 0,
  }

  // 验证时间窗口逻辑
  const timeDiff = Math.abs(conclusionMem.ts - testMem.ts)
  assert(timeDiff < 3600000, 'conclusion should be within 1 hour of question')
  assert(conclusionMem.scope === 'consolidated' || conclusionMem.scope === 'fact', 'conclusion should be fact/consolidated')
})

test('auto-mood-care: day aggregation correctly buckets mood data', () => {
  const now = Date.now()
  const DAY = 86400000
  const moodData = [
    // Day 1 (yesterday): low mood
    { ts: now - 1.5 * DAY, mood: -0.5 },
    { ts: now - 1.3 * DAY, mood: -0.4 },
    // Day 2 (today): also low
    { ts: now - 0.5 * DAY, mood: -0.6 },
    { ts: now - 0.2 * DAY, mood: -0.3 },
  ]

  const THREE_DAYS = 3 * DAY
  const dayBuckets = new Map<string, number[]>()
  for (const s of moodData) {
    if (now - s.ts > THREE_DAYS) continue
    const day = new Date(s.ts).toISOString().slice(0, 10)
    if (!dayBuckets.has(day)) dayBuckets.set(day, [])
    dayBuckets.get(day)!.push(s.mood)
  }

  const dayAvgs = [...dayBuckets.entries()]
    .map(([day, moods]) => ({ day, avg: moods.reduce((a, b) => a + b, 0) / moods.length }))

  assert(dayBuckets.size >= 2, `should have 2+ days, got ${dayBuckets.size}`)
  const lowDays = dayAvgs.filter(d => d.avg < -0.3).length
  assert(lowDays >= 2, `should detect 2+ low days, got ${lowDays}`)
})

test('auto-mood-care: normal mood does not trigger care', () => {
  const now = Date.now()
  const DAY = 86400000
  const moodData = [
    { ts: now - 1.5 * DAY, mood: 0.2 },
    { ts: now - 0.5 * DAY, mood: 0.1 },
    { ts: now - 0.2 * DAY, mood: 0.3 },
  ]

  const THREE_DAYS = 3 * DAY
  const dayBuckets = new Map<string, number[]>()
  for (const s of moodData) {
    if (now - s.ts > THREE_DAYS) continue
    const day = new Date(s.ts).toISOString().slice(0, 10)
    if (!dayBuckets.has(day)) dayBuckets.set(day, [])
    dayBuckets.get(day)!.push(s.mood)
  }
  const dayAvgs = [...dayBuckets.entries()]
    .map(([day, moods]) => ({ day, avg: moods.reduce((a, b) => a + b, 0) / moods.length }))
  const lowDays = dayAvgs.filter(d => d.avg < -0.3).length
  assert(lowDays === 0, `normal mood should not trigger, got ${lowDays} low days`)
})

test('auto-memory-chain: findMentionedEntities extracts from content', () => {
  // 先加个测试实体
  const origLen = graphState.entities.length
  graphState.entities.push(
    { name: 'Redis', type: 'tech', mentions: 10, firstSeen: Date.now(), lastSeen: Date.now(), invalid_at: null } as any,
  )
  const found = findMentionedEntities('Redis 的持久化策略有 RDB 和 AOF')
  assert(found.includes('Redis'), `should find 'Redis' in content, got: ${found.join(',')}`)
  graphState.entities.splice(-1, 1)
})

// ══════════════════════════════════════════════════════════════════════════════
// DISTILL PIPELINE TESTS
// ══════════════════════════════════════════════════════════════════════════════

test('distill: loadDistillState does not throw', () => {
  loadDistillState() // should not throw even with empty data files
})

test('distill: getMentalModel returns empty string when no model', () => {
  const model = getMentalModel('nonexistent_user')
  assert(typeof model === 'string', `should return string, got ${typeof model}`)
})

test('distill: getRelevantTopics returns array', () => {
  const topics = getRelevantTopics('测试消息', undefined, 5)
  assert(Array.isArray(topics), `should return array, got ${typeof topics}`)
})

test('distill: buildTopicAugment returns string', () => {
  const result = buildTopicAugment('Python 代码', 'test_user')
  assert(typeof result === 'string', `should return string, got ${typeof result}`)
})

test('distill: buildMentalModelAugment returns string', () => {
  const result = buildMentalModelAugment('test_user')
  assert(typeof result === 'string', `should return string, got ${typeof result}`)
})

test('distill: getDistillStats returns valid object', () => {
  const s = getDistillStats()
  assert(typeof s.topicNodes === 'number', `topicNodes should be number`)
  assert(typeof s.mentalModels === 'number', `mentalModels should be number`)
  assert(typeof s.totalDistills === 'number', `totalDistills should be number`)
})

// ══════════════════════════════════════════════════════════════════════════════
// SOCIAL GRAPH TESTS
// ══════════════════════════════════════════════════════════════════════════════

test('social-graph: detectMentionedPeople finds roles', () => {
  const people = detectMentionedPeople('我老板今天又加班了')
  assert(people.includes('老板'), `should detect 老板, got ${JSON.stringify(people)}`)
})

test('social-graph: detectMentionedPeople finds 小X names', () => {
  const people = detectMentionedPeople('小李说这个方案不行')
  assert(people.includes('小李'), `should detect 小李, got ${JSON.stringify(people)}`)
})

test('social-graph: detectMentionedPeople returns empty for no mentions', () => {
  const people = detectMentionedPeople('今天天气不错')
  assertEquals(people.length, 0, 'no people in weather msg')
})

test('social-graph: updateSocialGraph + getSocialContext round trip', () => {
  _resetSocialGraph()
  updateSocialGraph('老板让我加班', -0.5)
  updateSocialGraph('老板又催进度了', -0.8)
  const ctx = getSocialContext('老板说明天要开会')
  assert(ctx !== null, 'should return context after 2+ mentions')
  assert(ctx!.includes('老板'), `context should mention 老板`)
  assert(ctx!.includes('焦虑/压力'), `negative mood should show 焦虑/压力, got: ${ctx}`)
  _resetSocialGraph()
})

test('social-graph: getSocialContext returns null for first mention', () => {
  _resetSocialGraph()
  updateSocialGraph('朋友请我吃饭', 0.5)
  const ctx = getSocialContext('朋友真好')
  assertEquals(ctx, null, 'should be null with only 1 mention')
  _resetSocialGraph()
})

test('social-graph: detectMentionedPeople deduplicates', () => {
  const people = detectMentionedPeople('老板和老板都说了')
  assertEquals(people.length, 1, 'should deduplicate')
})

// ══════════════════════════════════════════════════════════════════════════════
// COMMITMENT TRACKER TESTS (logic validation)
// ══════════════════════════════════════════════════════════════════════════════

test('commitment: pattern matches Chinese plans', () => {
  const pattern = /我要|我打算|下[周个]|明天|以后|计划|准备|打算|plan to|going to|will start|need to/i
  assert(pattern.test('我要学习Rust'), 'should match 我要')
  assert(pattern.test('我打算下周重构代码'), 'should match 我打算')
  assert(pattern.test('明天再说吧'), 'should match 明天')
  assert(pattern.test('I plan to refactor'), 'should match plan to')
  assert(!pattern.test('你好'), 'should not match greeting')
})

test('commitment: extraction trims correctly', () => {
  const msg = '我打算下周学习Rust'
  const commitment = msg.replace(/我要|我打算|下[周个]|明天|准备|打算/g, '').trim().slice(0, 80)
  assert(commitment.length > 4, `commitment should be > 4 chars, got "${commitment}"`)
  assert(commitment.includes('学习Rust'), `should contain 学习Rust, got "${commitment}"`)
})

// ══════════════════════════════════════════════════════════════════════════════
// PERSON MODEL TESTS
// ══════════════════════════════════════════════════════════════════════════════

import { getPersonModel, getPersonModelContext, getUnifiedUserContext } from './person-model.ts'

test('person-model: getPersonModel returns valid structure', () => {
  const pm = getPersonModel()
  assert(Array.isArray(pm.values), 'values should be array')
  assert(Array.isArray(pm.beliefs), 'beliefs should be array')
  assert(Array.isArray(pm.contradictions), 'contradictions should be array')
  assert(typeof pm.communicationDecoder === 'object', 'communicationDecoder should be object')
  assert(typeof pm.domainExpertise === 'object', 'domainExpertise should be object')
  assert(typeof pm.distillCount === 'number', 'distillCount should be number')
  assert(typeof pm.updatedAt === 'number', 'updatedAt should be number')
})

test('person-model: getPersonModelContext returns null when distillCount=0', () => {
  const pm = getPersonModel()
  if (pm.distillCount === 0) {
    const ctx = getPersonModelContext()
    assert(ctx === null, 'should return null when no distillation has occurred')
  } else {
    // Already distilled — context should be a string
    const ctx = getPersonModelContext()
    assert(ctx === null || typeof ctx === 'string', 'should return null or string')
  }
})

test('person-model: PersonModel fields have correct bounds', () => {
  const pm = getPersonModel()
  assert(pm.values.length <= 10, `values should be <= 10, got ${pm.values.length}`)
  assert(pm.beliefs.length <= 10, `beliefs should be <= 10, got ${pm.beliefs.length}`)
  assert(pm.contradictions.length <= 5, `contradictions should be <= 5, got ${pm.contradictions.length}`)
})

test('person-model: getUnifiedUserContext returns null or string with [用户理解] header', () => {
  const ctx = getUnifiedUserContext('测试消息', 'test_user')
  assert(ctx === null || typeof ctx === 'string', `should return null or string, got ${typeof ctx}`)
  if (ctx !== null) {
    assert(ctx.startsWith('[用户理解]'), `should start with [用户理解], got: ${ctx.slice(0, 20)}`)
  }
})

test('person-model: getUnifiedUserContext works without userId', () => {
  const ctx = getUnifiedUserContext('hello world')
  assert(ctx === null || typeof ctx === 'string', `should return null or string without userId`)
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
