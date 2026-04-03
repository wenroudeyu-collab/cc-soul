/**
 * benchmark-recall-en.ts — Vector-free recall benchmark (English)
 * Usage: npx tsx cc-soul/benchmark-recall-en.ts
 */

import { createRequire } from 'module'
import type { Memory } from './types.ts'

const require = createRequire(import.meta.url)

// Lazy-load modules to avoid side effects
const { activationRecall } = require('./activation-field.ts')
const { expandQuery, learnAssociation } = require('./aam.ts')

// ═══════════════════════════════════════════════════════════════
// TEST DATA: 40 English memories
// ═══════════════════════════════════════════════════════════════

const DAY = 86400000

const TEST_MEMORIES: Memory[] = [
  /* 0  */ { content: 'I wake up at 6am every day', scope: 'fact', ts: Date.now() - DAY * 30, confidence: 0.9, recallCount: 5, lastAccessed: Date.now() - DAY * 2 },
  /* 1  */ { content: "I'm allergic to shellfish", scope: 'fact', ts: Date.now() - DAY * 200, confidence: 0.92, recallCount: 4, lastAccessed: Date.now() - DAY * 15 },
  /* 2  */ { content: 'My car is a BMW 3 Series, 2022 model', scope: 'fact', ts: Date.now() - DAY * 90, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - DAY * 10 },
  /* 3  */ { content: 'I got promoted to senior engineer last month', scope: 'fact', ts: Date.now() - DAY * 25, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - DAY * 3 },
  /* 4  */ { content: 'My son plays soccer every Saturday', scope: 'fact', ts: Date.now() - DAY * 60, confidence: 0.85, recallCount: 5, lastAccessed: Date.now() - DAY * 7 },
  /* 5  */ { content: 'I quit drinking 3 months ago', scope: 'fact', ts: Date.now() - DAY * 15, confidence: 0.87, recallCount: 3, lastAccessed: Date.now() - DAY * 5 },
  /* 6  */ { content: "I'm afraid of heights", scope: 'fact', ts: Date.now() - DAY * 150, confidence: 0.9, recallCount: 2, lastAccessed: Date.now() - DAY * 30 },
  /* 7  */ { content: 'Planning a trip to Italy in June', scope: 'episode', ts: Date.now() - DAY * 5, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 1 },
  /* 8  */ { content: 'My college roommate Kevin works at Google now', scope: 'fact', ts: Date.now() - DAY * 120, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - DAY * 20 },
  /* 9  */ { content: 'My blood type is A positive', scope: 'fact', ts: Date.now() - DAY * 250, confidence: 0.95, recallCount: 1, lastAccessed: Date.now() - DAY * 60 },
  /* 10 */ { content: 'I usually read before bed', scope: 'fact', ts: Date.now() - DAY * 45, confidence: 0.85, recallCount: 4, lastAccessed: Date.now() - DAY * 3 },
  /* 11 */ { content: "I'm thinking about doing an MBA", scope: 'fact', ts: Date.now() - DAY * 10, confidence: 0.78, recallCount: 2, lastAccessed: Date.now() - DAY * 2 },
  /* 12 */ { content: 'Lost $5000 in crypto last year', scope: 'fact', ts: Date.now() - DAY * 180, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - DAY * 25 },
  /* 13 */ { content: "I'm learning Spanish, about A2 level", scope: 'fact', ts: Date.now() - DAY * 40, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 5 },
  /* 14 */ { content: 'Met my wife on a dating app', scope: 'fact', ts: Date.now() - DAY * 300, confidence: 0.93, recallCount: 5, lastAccessed: Date.now() - DAY * 40 },
  /* 15 */ { content: 'I use a ThinkPad X1 Carbon for work', scope: 'fact', ts: Date.now() - DAY * 50, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - DAY * 8 },
  /* 16 */ { content: 'I play basketball every Wednesday', scope: 'fact', ts: Date.now() - DAY * 35, confidence: 0.83, recallCount: 4, lastAccessed: Date.now() - DAY * 3 },
  /* 17 */ { content: 'Currently reading Sapiens by Yuval Harari', scope: 'fact', ts: Date.now() - DAY * 8, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 2 },
  /* 18 */ { content: 'Had knee surgery two years ago', scope: 'fact', ts: Date.now() - DAY * 100, confidence: 0.9, recallCount: 2, lastAccessed: Date.now() - DAY * 35 },
  /* 19 */ { content: 'I work at Microsoft as a PM', scope: 'fact', ts: Date.now() - DAY * 20, confidence: 0.92, recallCount: 6, lastAccessed: Date.now() - DAY * 1 },
  /* 20 */ { content: "My daughter's birthday is March 15", scope: 'fact', ts: Date.now() - DAY * 70, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - DAY * 10 },
  /* 21 */ { content: 'I prefer Python over Java', scope: 'preference', ts: Date.now() - DAY * 110, confidence: 0.87, recallCount: 4, lastAccessed: Date.now() - DAY * 12 },
  /* 22 */ { content: 'My mortgage is $2500/month', scope: 'fact', ts: Date.now() - DAY * 55, confidence: 0.9, recallCount: 2, lastAccessed: Date.now() - DAY * 15 },
  /* 23 */ { content: 'I meditate for 20 minutes every morning', scope: 'fact', ts: Date.now() - DAY * 28, confidence: 0.88, recallCount: 5, lastAccessed: Date.now() - DAY * 1 },
  /* 24 */ { content: 'My mom lives in Chicago', scope: 'fact', ts: Date.now() - DAY * 365, confidence: 0.95, recallCount: 4, lastAccessed: Date.now() - DAY * 20 },
  /* 25 */ { content: "I'm training for a half marathon", scope: 'fact', ts: Date.now() - DAY * 12, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 2 },
  /* 26 */ { content: 'I switched from iPhone to Android last year', scope: 'fact', ts: Date.now() - DAY * 160, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - DAY * 30 },
  /* 27 */ { content: 'I have two cats named Luna and Mochi', scope: 'fact', ts: Date.now() - DAY * 80, confidence: 0.9, recallCount: 6, lastAccessed: Date.now() - DAY * 1 },
  /* 28 */ { content: "My favorite restaurant is the Italian place on 5th Street", scope: 'preference', ts: Date.now() - DAY * 130, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 7 },
  /* 29 */ { content: "I've been having back pain since January", scope: 'fact', ts: Date.now() - DAY * 18, confidence: 0.83, recallCount: 3, lastAccessed: Date.now() - DAY * 4 },
  /* 30 */ { content: 'I volunteer at the food bank on Sundays', scope: 'fact', ts: Date.now() - DAY * 42, confidence: 0.85, recallCount: 4, lastAccessed: Date.now() - DAY * 3 },
  /* 31 */ { content: 'My team has 8 people', scope: 'fact', ts: Date.now() - DAY * 22, confidence: 0.87, recallCount: 3, lastAccessed: Date.now() - DAY * 5 },
  /* 32 */ { content: 'I commute by train, takes 45 minutes', scope: 'fact', ts: Date.now() - DAY * 65, confidence: 0.85, recallCount: 4, lastAccessed: Date.now() - DAY * 1 },
  /* 33 */ { content: "I'm considering buying a house", scope: 'fact', ts: Date.now() - DAY * 3, confidence: 0.78, recallCount: 2, lastAccessed: Date.now() - DAY * 1 },
  /* 34 */ { content: 'My best friend Dave lives in London', scope: 'fact', ts: Date.now() - DAY * 140, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - DAY * 18 },
  /* 35 */ { content: 'I do intermittent fasting, 16:8', scope: 'fact', ts: Date.now() - DAY * 38, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 2 },
  /* 36 */ { content: 'Last vacation was in Bali, loved it', scope: 'episode', ts: Date.now() - DAY * 170, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 40 },
  /* 37 */ { content: "I'm mentoring two junior engineers", scope: 'fact', ts: Date.now() - DAY * 14, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 3 },
  /* 38 */ { content: 'My annual review is in December', scope: 'fact', ts: Date.now() - DAY * 48, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 10 },
  /* 39 */ { content: 'I started a side project, a recipe app', scope: 'fact', ts: Date.now() - DAY * 7, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - DAY * 1 },
] as Memory[]

// ═══════════════════════════════════════════════════════════════
// TEST QUERIES: 80 cases (40 direct + 40 semantic)
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  query: string
  expectedIndex: number | number[]  // single index or array (multi-match: pass if ANY hit)
  type: 'direct' | 'semantic'
  description: string
}

const TEST_CASES: TestCase[] = [
  // ── Direct queries (40) ──────────────────────────────────────
  { query: 'What time do I wake up', expectedIndex: 0, type: 'direct', description: 'wake up → 6am' },
  { query: 'What am I allergic to', expectedIndex: 1, type: 'direct', description: 'allergic → shellfish' },
  { query: 'What car do I drive', expectedIndex: 2, type: 'direct', description: 'car → BMW' },
  { query: "What's my job title", expectedIndex: 3, type: 'direct', description: 'job title → senior eng' },
  { query: 'What sport does my son play', expectedIndex: 4, type: 'direct', description: 'son sport → soccer' },
  { query: 'How long since I quit drinking', expectedIndex: 5, type: 'direct', description: 'quit drinking → 3mo' },
  { query: 'What am I afraid of', expectedIndex: 6, type: 'direct', description: 'afraid → heights' },
  { query: 'Where am I traveling next', expectedIndex: 7, type: 'direct', description: 'travel → Italy' },
  { query: 'Where does my roommate Kevin work', expectedIndex: 8, type: 'direct', description: 'Kevin → Google' },
  { query: "What's my blood type", expectedIndex: 9, type: 'direct', description: 'blood type → A+' },
  { query: 'What do I do before bed', expectedIndex: 10, type: 'direct', description: 'before bed → read' },
  { query: 'What degree am I considering', expectedIndex: 11, type: 'direct', description: 'degree → MBA' },
  { query: 'How much did I lose in crypto', expectedIndex: 12, type: 'direct', description: 'crypto → $5000' },
  { query: 'What language am I learning', expectedIndex: 13, type: 'direct', description: 'language → Spanish' },
  { query: 'How did I meet my wife', expectedIndex: 14, type: 'direct', description: 'meet wife → dating app' },
  { query: 'What laptop do I use', expectedIndex: 15, type: 'direct', description: 'laptop → ThinkPad' },
  { query: 'What sport do I play on Wednesdays', expectedIndex: 16, type: 'direct', description: 'Wednesday → basketball' },
  { query: 'What book am I reading', expectedIndex: 17, type: 'direct', description: 'book → Sapiens' },
  { query: 'What surgery have I had', expectedIndex: 18, type: 'direct', description: 'surgery → knee' },
  { query: 'Where do I work', expectedIndex: 19, type: 'direct', description: 'work → Microsoft' },
  { query: "When is my daughter's birthday", expectedIndex: 20, type: 'direct', description: 'daughter bday → Mar 15' },
  { query: 'Which programming language do I prefer', expectedIndex: 21, type: 'direct', description: 'prefer → Python' },
  { query: 'How much is my mortgage', expectedIndex: 22, type: 'direct', description: 'mortgage → $2500' },
  { query: 'Do I meditate', expectedIndex: 23, type: 'direct', description: 'meditate → yes 20min' },
  { query: 'Where does my mom live', expectedIndex: 24, type: 'direct', description: 'mom → Chicago' },
  { query: 'What am I training for', expectedIndex: 25, type: 'direct', description: 'training → half marathon' },
  { query: 'iPhone or Android', expectedIndex: 26, type: 'direct', description: 'phone → Android' },
  { query: "What are my cats' names", expectedIndex: 27, type: 'direct', description: 'cats → Luna & Mochi' },
  { query: "What's my favorite restaurant", expectedIndex: 28, type: 'direct', description: 'restaurant → Italian 5th' },
  { query: 'What health issue do I have', expectedIndex: 29, type: 'direct', description: 'health → back pain' },
  { query: 'What do I do on Sundays', expectedIndex: 30, type: 'direct', description: 'Sundays → food bank' },
  { query: 'How big is my team', expectedIndex: 31, type: 'direct', description: 'team → 8 people' },
  { query: 'How do I commute', expectedIndex: 32, type: 'direct', description: 'commute → train 45min' },
  { query: 'Am I looking to buy property', expectedIndex: 33, type: 'direct', description: 'property → yes' },
  { query: 'Who is my best friend', expectedIndex: 34, type: 'direct', description: 'best friend → Dave' },
  { query: 'What diet do I follow', expectedIndex: 35, type: 'direct', description: 'diet → IF 16:8' },
  { query: 'Where was my last vacation', expectedIndex: 36, type: 'direct', description: 'vacation → Bali' },
  { query: 'Am I mentoring anyone', expectedIndex: 37, type: 'direct', description: 'mentoring → 2 juniors' },
  { query: 'When is my annual review', expectedIndex: 38, type: 'direct', description: 'review → December' },
  { query: "What's my side project", expectedIndex: 39, type: 'direct', description: 'side project → recipe app' },

  // ── Semantic queries (40) ────────────────────────────────────
  { query: 'my morning routine', expectedIndex: [0, 23], type: 'semantic', description: 'morning → 6am + meditate' },
  { query: 'my food restrictions', expectedIndex: 1, type: 'semantic', description: 'food restrict → shellfish' },
  { query: 'my vehicle', expectedIndex: 2, type: 'semantic', description: 'vehicle → BMW' },
  { query: 'my career progress', expectedIndex: 3, type: 'semantic', description: 'career → promoted' },
  { query: "my kid's activities", expectedIndex: 4, type: 'semantic', description: 'kid activities → soccer' },
  { query: "addictions I've overcome", expectedIndex: 5, type: 'semantic', description: 'addiction → quit drinking' },
  { query: 'my phobias', expectedIndex: 6, type: 'semantic', description: 'phobias → heights' },
  { query: 'upcoming travel plans', expectedIndex: 7, type: 'semantic', description: 'travel plans → Italy' },
  { query: 'old friends from school', expectedIndex: 8, type: 'semantic', description: 'old friends → Kevin' },
  { query: 'my health profile', expectedIndex: [9, 18, 29], type: 'semantic', description: 'health → A+/knee/back' },
  { query: 'my nighttime habits', expectedIndex: 10, type: 'semantic', description: 'nighttime → reading' },
  { query: 'my education plans', expectedIndex: 11, type: 'semantic', description: 'education → MBA' },
  { query: 'my investment losses', expectedIndex: 12, type: 'semantic', description: 'investment → crypto' },
  { query: 'self improvement efforts', expectedIndex: [13, 37], type: 'semantic', description: 'self improve → Spanish + mentoring' },
  { query: 'my love story', expectedIndex: 14, type: 'semantic', description: 'love story → dating app' },
  { query: 'my work setup', expectedIndex: 15, type: 'semantic', description: 'work setup → ThinkPad' },
  { query: 'my weekly exercise', expectedIndex: [16, 25], type: 'semantic', description: 'exercise → basketball + marathon' },
  { query: "what I'm reading lately", expectedIndex: 17, type: 'semantic', description: 'reading → Sapiens' },
  { query: 'past medical procedures', expectedIndex: 18, type: 'semantic', description: 'medical → knee surgery' },
  { query: 'my employer', expectedIndex: 19, type: 'semantic', description: 'employer → Microsoft' },
  { query: 'important family dates', expectedIndex: 20, type: 'semantic', description: 'family dates → Mar 15' },
  { query: 'my tech stack preferences', expectedIndex: 21, type: 'semantic', description: 'tech stack → Python' },
  { query: 'my monthly expenses', expectedIndex: 22, type: 'semantic', description: 'expenses → mortgage' },
  { query: 'my wellness practices', expectedIndex: [23, 35], type: 'semantic', description: 'wellness → meditation + fasting' },
  { query: "my family's locations", expectedIndex: 24, type: 'semantic', description: 'family location → Chicago' },
  { query: 'my fitness goals', expectedIndex: 25, type: 'semantic', description: 'fitness → half marathon' },
  { query: 'my phone choice', expectedIndex: 26, type: 'semantic', description: 'phone → Android' },
  { query: 'my pets', expectedIndex: 27, type: 'semantic', description: 'pets → Luna & Mochi' },
  { query: 'my dining preferences', expectedIndex: 28, type: 'semantic', description: 'dining → Italian 5th' },
  { query: 'chronic health issues', expectedIndex: 29, type: 'semantic', description: 'chronic → back pain' },
  { query: 'my community involvement', expectedIndex: 30, type: 'semantic', description: 'community → food bank' },
  { query: 'my work environment', expectedIndex: 31, type: 'semantic', description: 'work env → team of 8' },
  { query: 'my daily commute', expectedIndex: 32, type: 'semantic', description: 'daily commute → train' },
  { query: 'major financial decisions ahead', expectedIndex: 33, type: 'semantic', description: 'financial → buy house' },
  { query: 'closest friendships', expectedIndex: 34, type: 'semantic', description: 'friendships → Dave' },
  { query: 'my eating habits', expectedIndex: 35, type: 'semantic', description: 'eating → IF 16:8' },
  { query: 'best travel memories', expectedIndex: 36, type: 'semantic', description: 'travel memories → Bali' },
  { query: 'my leadership role', expectedIndex: 37, type: 'semantic', description: 'leadership → mentoring' },
  { query: 'upcoming work milestones', expectedIndex: 38, type: 'semantic', description: 'milestones → review Dec' },
  { query: 'my hobby projects', expectedIndex: 39, type: 'semantic', description: 'hobby → recipe app' },
]

// ═══════════════════════════════════════════════════════════════
// BENCHMARK
// ═══════════════════════════════════════════════════════════════

function checkHit(results: Memory[], expectedIndex: number | number[]): { hit: boolean; isTop1: boolean } {
  const resultContents = results.map(r => r.content)
  if (Array.isArray(expectedIndex)) {
    // Multi-match: pass if ANY expected memory appears in top-3
    const anyHit = expectedIndex.some(i => resultContents.includes(TEST_MEMORIES[i].content))
    const anyTop1 = expectedIndex.some(i => resultContents[0] === TEST_MEMORIES[i].content)
    return { hit: anyHit, isTop1: anyTop1 }
  }
  const expectedContent = TEST_MEMORIES[expectedIndex].content
  return {
    hit: resultContents.includes(expectedContent),
    isTop1: resultContents[0] === expectedContent,
  }
}

function runBenchmark() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  cc-soul Vector-Free Recall Benchmark (English)')
  console.log('═══════════════════════════════════════════════════════════')
  console.log()

  // Let AAM learn all test memories (simulating real usage)
  for (const mem of TEST_MEMORIES) {
    learnAssociation(mem.content, 0.3)
  }

  // Populate fact-store from test memories
  try {
    const factStore = require('./fact-store.ts')
    for (const mem of TEST_MEMORIES) {
      factStore.extractAndStoreFacts?.(mem.content, 'user')
    }
  } catch {}

  let directHits = 0, directTotal = 0
  let semanticHits = 0, semanticTotal = 0
  let top1Hits = 0
  const failures: { query: string; type: string; desc: string; got: string[] }[] = []

  for (const tc of TEST_CASES) {
    const results = activationRecall(TEST_MEMORIES, tc.query, 3, 0, 0.5) as Memory[]
    const { hit, isTop1 } = checkHit(results, tc.expectedIndex)

    if (tc.type === 'direct') {
      directTotal++
      if (hit) directHits++
    } else {
      semanticTotal++
      if (hit) semanticHits++
    }
    if (isTop1) top1Hits++

    if (!hit) {
      failures.push({
        query: tc.query,
        type: tc.type,
        desc: tc.description,
        got: results.map(r => r.content.slice(0, 40)),
      })
    }

    const mark = hit ? (isTop1 ? '✅' : '🟡') : '❌'
    console.log(`${mark} [${tc.type.padEnd(8)}] ${tc.description.padEnd(30)} | ${tc.query}`)
  }

  console.log()
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Results')
  console.log('═══════════════════════════════════════════════════════════')
  console.log()
  const directRate = (directHits / directTotal * 100).toFixed(0)
  const semanticRate = (semanticHits / semanticTotal * 100).toFixed(0)
  const totalRate = ((directHits + semanticHits) / (directTotal + semanticTotal) * 100).toFixed(0)
  const top1Rate = (top1Hits / (directTotal + semanticTotal) * 100).toFixed(0)

  console.log(`  Direct recall (top-3):   ${directHits}/${directTotal} = ${directRate}%`)
  console.log(`  Semantic recall (top-3): ${semanticHits}/${semanticTotal} = ${semanticRate}%`)
  console.log(`  Overall (top-3):         ${(directHits + semanticHits)}/${(directTotal + semanticTotal)} = ${totalRate}%`)
  console.log(`  Top-1 accuracy:          ${top1Hits}/${(directTotal + semanticTotal)} = ${top1Rate}%`)
  console.log()

  if (failures.length > 0) {
    console.log('  ── Failed cases ──')
    for (const f of failures) {
      console.log(`  ❌ [${f.type}] ${f.desc}: "${f.query}"`)
      console.log(`     Got: ${f.got.join(' | ')}`)
    }
  }
}

runBenchmark()
