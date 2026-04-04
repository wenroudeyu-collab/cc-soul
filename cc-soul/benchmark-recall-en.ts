/**
 * benchmark-recall-en.ts — Vector-free recall benchmark (English)
 * Usage: npx tsx cc-soul/benchmark-recall-en.ts
 */

import { createRequire } from 'module'
import type { Memory } from './types.ts'

const require = createRequire(import.meta.url)
;(globalThis as any).require = require
process.env.CC_SOUL_BENCHMARK = "1"

// Lazy-load modules to avoid side effects
const { activationRecall } = require('./activation-field.ts')
const { expandQuery, learnAssociation } = require('./aam.ts')

// ═══════════════════════════════════════════════════════════════
// TEST DATA: 80 English memories
// ═══════════════════════════════════════════════════════════════

const DAY = 86400000

const TEST_MEMORIES: Memory[] = [
  // ── Original 40 (index 0–39) ──────────────────────────────────
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

  // ── New 40 (index 40–79) ──────────────────────────────────────
  /* 40 */ { content: 'I drink oat milk instead of regular milk', scope: 'preference', ts: Date.now() - DAY * 75, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 4 },
  /* 41 */ { content: 'My favorite TV show is Breaking Bad', scope: 'preference', ts: Date.now() - DAY * 200, confidence: 0.9, recallCount: 4, lastAccessed: Date.now() - DAY * 30 },
  /* 42 */ { content: 'I wake up at 5:30am on weekdays for the gym', scope: 'fact', ts: Date.now() - DAY * 20, confidence: 0.88, recallCount: 5, lastAccessed: Date.now() - DAY * 1 },
  /* 43 */ { content: "I'm vegetarian, have been for 3 years", scope: 'fact', ts: Date.now() - DAY * 180, confidence: 0.92, recallCount: 4, lastAccessed: Date.now() - DAY * 6 },
  /* 44 */ { content: 'My sister lives in Seattle, we FaceTime every Sunday', scope: 'fact', ts: Date.now() - DAY * 150, confidence: 0.9, recallCount: 5, lastAccessed: Date.now() - DAY * 3 },
  /* 45 */ { content: "I've been journaling every night before bed", scope: 'fact', ts: Date.now() - DAY * 35, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 1 },
  /* 46 */ { content: 'My car insurance is with Geico, about $150/month', scope: 'fact', ts: Date.now() - DAY * 90, confidence: 0.87, recallCount: 2, lastAccessed: Date.now() - DAY * 20 },
  /* 47 */ { content: "I'm learning to play guitar, bought one last month", scope: 'fact', ts: Date.now() - DAY * 8, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 2 },
  /* 48 */ { content: 'I use Notion for all my note-taking', scope: 'fact', ts: Date.now() - DAY * 60, confidence: 0.88, recallCount: 4, lastAccessed: Date.now() - DAY * 3 },
  /* 49 */ { content: 'My childhood dream was to be an astronaut', scope: 'fact', ts: Date.now() - DAY * 300, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - DAY * 50 },
  /* 50 */ { content: 'I hate spiders, had a bad experience as a kid', scope: 'fact', ts: Date.now() - DAY * 220, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - DAY * 25 },
  /* 51 */ { content: 'I donate to the Red Cross every Christmas', scope: 'fact', ts: Date.now() - DAY * 100, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - DAY * 60 },
  /* 52 */ { content: 'My favorite cuisine is Thai food', scope: 'preference', ts: Date.now() - DAY * 110, confidence: 0.88, recallCount: 4, lastAccessed: Date.now() - DAY * 8 },
  /* 53 */ { content: 'I have a standing desk at home', scope: 'fact', ts: Date.now() - DAY * 45, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 5 },
  /* 54 */ { content: "I'm trying to reduce my screen time to under 3 hours", scope: 'fact', ts: Date.now() - DAY * 15, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - DAY * 3 },
  /* 55 */ { content: 'I broke my arm playing football in college', scope: 'fact', ts: Date.now() - DAY * 280, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - DAY * 45 },
  /* 56 */ { content: "My neighbor's dog barks every morning at 6am", scope: 'fact', ts: Date.now() - DAY * 30, confidence: 0.8, recallCount: 3, lastAccessed: Date.now() - DAY * 2 },
  /* 57 */ { content: 'I subscribe to Netflix, Disney+, and HBO Max', scope: 'fact', ts: Date.now() - DAY * 55, confidence: 0.87, recallCount: 3, lastAccessed: Date.now() - DAY * 4 },
  /* 58 */ { content: "I'm planning to propose to my girlfriend in September", scope: 'fact', ts: Date.now() - DAY * 5, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 1 },
  /* 59 */ { content: 'My grandma taught me how to make pasta from scratch', scope: 'fact', ts: Date.now() - DAY * 350, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - DAY * 35 },
  /* 60 */ { content: 'I run 5K every Tuesday and Thursday morning', scope: 'fact', ts: Date.now() - DAY * 25, confidence: 0.85, recallCount: 4, lastAccessed: Date.now() - DAY * 2 },
  /* 61 */ { content: "My brother is a dentist in Portland", scope: 'fact', ts: Date.now() - DAY * 200, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - DAY * 22 },
  /* 62 */ { content: 'I have a peanut allergy, carry an EpiPen', scope: 'fact', ts: Date.now() - DAY * 250, confidence: 0.95, recallCount: 4, lastAccessed: Date.now() - DAY * 10 },
  /* 63 */ { content: 'My favorite band is Radiohead', scope: 'preference', ts: Date.now() - DAY * 180, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - DAY * 15 },
  /* 64 */ { content: 'I take vitamin D and omega-3 supplements daily', scope: 'fact', ts: Date.now() - DAY * 40, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 3 },
  /* 65 */ { content: "I'm saving up for a Tesla Model 3", scope: 'fact', ts: Date.now() - DAY * 10, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - DAY * 2 },
  /* 66 */ { content: 'I coached my daughter\'s soccer team last season', scope: 'fact', ts: Date.now() - DAY * 120, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - DAY * 28 },
  /* 67 */ { content: 'I have a tattoo of a compass on my left forearm', scope: 'fact', ts: Date.now() - DAY * 400, confidence: 0.92, recallCount: 2, lastAccessed: Date.now() - DAY * 55 },
  /* 68 */ { content: 'I failed my first driving test when I was 16', scope: 'fact', ts: Date.now() - DAY * 350, confidence: 0.85, recallCount: 1, lastAccessed: Date.now() - DAY * 70 },
  /* 69 */ { content: 'My WiFi password is taped under the router', scope: 'fact', ts: Date.now() - DAY * 80, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 12 },
  /* 70 */ { content: 'I always order extra hot sauce on my burrito', scope: 'preference', ts: Date.now() - DAY * 95, confidence: 0.83, recallCount: 3, lastAccessed: Date.now() - DAY * 6 },
  /* 71 */ { content: 'I did a coding bootcamp before my CS degree', scope: 'fact', ts: Date.now() - DAY * 320, confidence: 0.88, recallCount: 2, lastAccessed: Date.now() - DAY * 40 },
  /* 72 */ { content: "I'm on a waitlist for a golden retriever puppy", scope: 'fact', ts: Date.now() - DAY * 6, confidence: 0.8, recallCount: 2, lastAccessed: Date.now() - DAY * 1 },
  /* 73 */ { content: 'I sleep with a white noise machine', scope: 'fact', ts: Date.now() - DAY * 70, confidence: 0.85, recallCount: 3, lastAccessed: Date.now() - DAY * 4 },
  /* 74 */ { content: 'I got food poisoning from sushi last month', scope: 'episode', ts: Date.now() - DAY * 4, confidence: 0.82, recallCount: 2, lastAccessed: Date.now() - DAY * 1 },
  /* 75 */ { content: 'My favorite movie is The Shawshank Redemption', scope: 'preference', ts: Date.now() - DAY * 190, confidence: 0.9, recallCount: 3, lastAccessed: Date.now() - DAY * 20 },
  /* 76 */ { content: 'I maxed out my 401k contributions this year', scope: 'fact', ts: Date.now() - DAY * 12, confidence: 0.87, recallCount: 2, lastAccessed: Date.now() - DAY * 5 },
  /* 77 */ { content: 'I have a fear of public speaking', scope: 'fact', ts: Date.now() - DAY * 160, confidence: 0.88, recallCount: 3, lastAccessed: Date.now() - DAY * 18 },
  /* 78 */ { content: 'I built a treehouse for my kids last summer', scope: 'episode', ts: Date.now() - DAY * 240, confidence: 0.85, recallCount: 2, lastAccessed: Date.now() - DAY * 50 },
  /* 79 */ { content: 'My go-to coffee order is a flat white with oat milk', scope: 'preference', ts: Date.now() - DAY * 50, confidence: 0.86, recallCount: 5, lastAccessed: Date.now() - DAY * 1 },
] as Memory[]

// ═══════════════════════════════════════════════════════════════
// TEST QUERIES: 200 cases (100 direct + 100 semantic)
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  query: string
  expectedIndex: number | number[]  // single index or array (multi-match: pass if ANY hit)
  type: 'direct' | 'semantic'
  description: string
}

const TEST_CASES: TestCase[] = [
  // ══════════════════════════════════════════════════════════════
  // ── Direct queries (100) ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  // Original 40 direct
  { query: 'What time do I wake up', expectedIndex: [0, 42], type: 'direct', description: 'wake up → 6am / 5:30am' },
  { query: 'What am I allergic to', expectedIndex: [1, 62], type: 'direct', description: 'allergic → shellfish / peanut' },
  { query: 'What car do I drive', expectedIndex: 2, type: 'direct', description: 'car → BMW' },
  { query: "What's my job title", expectedIndex: 3, type: 'direct', description: 'job title → senior eng' },
  { query: 'What sport does my son play', expectedIndex: 4, type: 'direct', description: 'son sport → soccer' },
  { query: 'How long since I quit drinking', expectedIndex: 5, type: 'direct', description: 'quit drinking → 3mo' },
  { query: 'What am I afraid of', expectedIndex: [6, 50, 77], type: 'direct', description: 'afraid → heights/spiders/speaking' },
  { query: 'Where am I traveling next', expectedIndex: 7, type: 'direct', description: 'travel → Italy' },
  { query: 'Where does my roommate Kevin work', expectedIndex: 8, type: 'direct', description: 'Kevin → Google' },
  { query: "What's my blood type", expectedIndex: 9, type: 'direct', description: 'blood type → A+' },
  { query: 'What do I do before bed', expectedIndex: [10, 45], type: 'direct', description: 'before bed → read / journal' },
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
  { query: 'What health issue do I have', expectedIndex: [29, 18, 55], type: 'direct', description: 'health → back/knee/arm' },
  { query: 'What do I do on Sundays', expectedIndex: [30, 44], type: 'direct', description: 'Sundays → food bank / FaceTime sister' },
  { query: 'How big is my team', expectedIndex: 31, type: 'direct', description: 'team → 8 people' },
  { query: 'How do I commute', expectedIndex: 32, type: 'direct', description: 'commute → train 45min' },
  { query: 'Am I looking to buy property', expectedIndex: 33, type: 'direct', description: 'property → yes' },
  { query: 'Who is my best friend', expectedIndex: 34, type: 'direct', description: 'best friend → Dave' },
  { query: 'What diet do I follow', expectedIndex: [35, 43], type: 'direct', description: 'diet → IF 16:8 / vegetarian' },
  { query: 'Where was my last vacation', expectedIndex: 36, type: 'direct', description: 'vacation → Bali' },
  { query: 'Am I mentoring anyone', expectedIndex: 37, type: 'direct', description: 'mentoring → 2 juniors' },
  { query: 'When is my annual review', expectedIndex: 38, type: 'direct', description: 'review → December' },
  { query: "What's my side project", expectedIndex: 39, type: 'direct', description: 'side project → recipe app' },

  // New 60 direct (for memories 40–79 + cross-memory)
  { query: 'Do I drink regular milk', expectedIndex: 40, type: 'direct', description: 'milk → oat milk' },
  { query: "What's my favorite TV show", expectedIndex: 41, type: 'direct', description: 'TV show → Breaking Bad' },
  { query: 'What time do I go to the gym', expectedIndex: 42, type: 'direct', description: 'gym time → 5:30am' },
  { query: 'Am I vegetarian', expectedIndex: 43, type: 'direct', description: 'vegetarian → yes 3 years' },
  { query: 'Where does my sister live', expectedIndex: 44, type: 'direct', description: 'sister → Seattle' },
  { query: 'Do I keep a journal', expectedIndex: 45, type: 'direct', description: 'journal → yes nightly' },
  { query: 'Who is my car insurance with', expectedIndex: 46, type: 'direct', description: 'car insurance → Geico $150' },
  { query: 'What instrument am I learning', expectedIndex: 47, type: 'direct', description: 'instrument → guitar' },
  { query: 'What app do I use for notes', expectedIndex: 48, type: 'direct', description: 'notes → Notion' },
  { query: 'What did I want to be as a kid', expectedIndex: 49, type: 'direct', description: 'childhood dream → astronaut' },
  { query: 'Am I scared of spiders', expectedIndex: 50, type: 'direct', description: 'spiders → yes' },
  { query: 'What charity do I donate to', expectedIndex: 51, type: 'direct', description: 'charity → Red Cross' },
  { query: 'What cuisine do I like most', expectedIndex: 52, type: 'direct', description: 'cuisine → Thai' },
  { query: 'Do I have a standing desk', expectedIndex: 53, type: 'direct', description: 'standing desk → yes' },
  { query: 'How much screen time am I targeting', expectedIndex: 54, type: 'direct', description: 'screen time → under 3hr' },
  { query: 'Have I ever broken a bone', expectedIndex: 55, type: 'direct', description: 'broken bone → arm football' },
  { query: "Does my neighbor's dog bother me", expectedIndex: 56, type: 'direct', description: 'neighbor dog → barks 6am' },
  { query: 'What streaming services do I have', expectedIndex: 57, type: 'direct', description: 'streaming → Netflix/Disney+/HBO' },
  { query: 'Am I planning to propose', expectedIndex: 58, type: 'direct', description: 'propose → September' },
  { query: 'Who taught me to make pasta', expectedIndex: 59, type: 'direct', description: 'pasta → grandma' },
  { query: 'How often do I run', expectedIndex: [25, 60], type: 'direct', description: 'running → 5K Tue/Thu + marathon' },
  { query: 'What does my brother do', expectedIndex: 61, type: 'direct', description: 'brother → dentist Portland' },
  { query: 'Do I carry an EpiPen', expectedIndex: 62, type: 'direct', description: 'EpiPen → peanut allergy' },
  { query: "What's my favorite band", expectedIndex: 63, type: 'direct', description: 'band → Radiohead' },
  { query: 'What supplements do I take', expectedIndex: 64, type: 'direct', description: 'supplements → vitamin D + omega-3' },
  { query: 'What car am I saving for', expectedIndex: 65, type: 'direct', description: 'saving → Tesla Model 3' },
  { query: "Did I coach my daughter's team", expectedIndex: 66, type: 'direct', description: 'coaching → daughter soccer' },
  { query: 'Do I have any tattoos', expectedIndex: 67, type: 'direct', description: 'tattoo → compass forearm' },
  { query: 'Did I pass my driving test first try', expectedIndex: 68, type: 'direct', description: 'driving test → failed first' },
  { query: 'Where is my WiFi password', expectedIndex: 69, type: 'direct', description: 'WiFi → under router' },
  { query: 'Do I like hot sauce', expectedIndex: 70, type: 'direct', description: 'hot sauce → extra on burrito' },
  { query: 'Did I do a coding bootcamp', expectedIndex: 71, type: 'direct', description: 'bootcamp → before CS degree' },
  { query: 'Am I getting a dog', expectedIndex: 72, type: 'direct', description: 'dog → golden retriever waitlist' },
  { query: 'Do I use a white noise machine', expectedIndex: 73, type: 'direct', description: 'white noise → yes' },
  { query: 'Have I had food poisoning recently', expectedIndex: 74, type: 'direct', description: 'food poisoning → sushi' },
  { query: "What's my favorite movie", expectedIndex: 75, type: 'direct', description: 'movie → Shawshank' },
  { query: 'Did I max out my 401k', expectedIndex: 76, type: 'direct', description: '401k → maxed out' },
  { query: 'Am I afraid of public speaking', expectedIndex: 77, type: 'direct', description: 'public speaking → yes' },
  { query: 'Did I build something for my kids', expectedIndex: 78, type: 'direct', description: 'built → treehouse' },
  { query: 'What do I order at the coffee shop', expectedIndex: 79, type: 'direct', description: 'coffee → flat white oat milk' },
  { query: 'How much is my car insurance', expectedIndex: 46, type: 'direct', description: 'insurance cost → $150/mo' },
  { query: 'What kind of milk do I put in my coffee', expectedIndex: [40, 79], type: 'direct', description: 'milk in coffee → oat milk' },
  { query: 'Do I have any allergies', expectedIndex: [1, 62], type: 'direct', description: 'allergies → shellfish + peanut' },
  { query: 'What do I do on Tuesday mornings', expectedIndex: 60, type: 'direct', description: 'Tuesday morning → 5K run' },
  { query: 'What is my morning workout', expectedIndex: [42, 60], type: 'direct', description: 'morning workout → gym / 5K' },
  { query: "What's my WiFi setup", expectedIndex: 69, type: 'direct', description: 'WiFi setup → password under router' },
  { query: 'What subscriptions do I pay for', expectedIndex: 57, type: 'direct', description: 'subscriptions → streaming' },
  { query: 'What kind of desk do I use at home', expectedIndex: 53, type: 'direct', description: 'desk → standing desk' },
  { query: 'Am I planning a wedding proposal', expectedIndex: 58, type: 'direct', description: 'wedding → propose Sept' },
  { query: 'What breed of dog am I getting', expectedIndex: 72, type: 'direct', description: 'dog breed → golden retriever' },
  { query: 'Do I take any vitamins', expectedIndex: 64, type: 'direct', description: 'vitamins → D + omega-3' },
  { query: 'What is my tattoo of', expectedIndex: 67, type: 'direct', description: 'tattoo design → compass' },
  { query: 'What did my grandma teach me to cook', expectedIndex: 59, type: 'direct', description: 'grandma cooking → pasta' },
  { query: "What's my brother's profession", expectedIndex: 61, type: 'direct', description: 'brother job → dentist' },
  { query: 'What was my childhood aspiration', expectedIndex: 49, type: 'direct', description: 'aspiration → astronaut' },
  { query: 'How long have I been vegetarian', expectedIndex: 43, type: 'direct', description: 'vegetarian duration → 3 years' },
  { query: 'What kind of puppy am I waiting for', expectedIndex: 72, type: 'direct', description: 'puppy → golden retriever' },
  { query: 'Do I journal or meditate', expectedIndex: [23, 45], type: 'direct', description: 'journal/meditate → both' },
  { query: 'What retirement savings do I have', expectedIndex: 76, type: 'direct', description: 'retirement → 401k maxed' },
  // ══════════════════════════════════════════════════════════════
  // ── Semantic queries (100) ───────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  // Original 40 semantic (updated for new memories)
  { query: 'my morning routine', expectedIndex: [0, 23, 42, 60], type: 'semantic', description: 'morning → 6am + meditate + gym + run' },
  { query: 'my food restrictions', expectedIndex: [1, 43, 62], type: 'semantic', description: 'food restrict → shellfish/veg/peanut' },
  { query: 'my vehicle', expectedIndex: [2, 65], type: 'semantic', description: 'vehicle → BMW / saving Tesla' },
  { query: 'my career progress', expectedIndex: 3, type: 'semantic', description: 'career → promoted' },
  { query: "my kid's activities", expectedIndex: [4, 66], type: 'semantic', description: 'kid activities → soccer / coaching' },
  { query: "addictions I've overcome", expectedIndex: 5, type: 'semantic', description: 'addiction → quit drinking' },
  { query: 'my phobias', expectedIndex: [6, 50, 77], type: 'semantic', description: 'phobias → heights/spiders/speaking' },
  { query: 'upcoming travel plans', expectedIndex: 7, type: 'semantic', description: 'travel plans → Italy' },
  { query: 'old friends from school', expectedIndex: 8, type: 'semantic', description: 'old friends → Kevin' },
  { query: 'my health profile', expectedIndex: [9, 18, 29, 55, 62], type: 'semantic', description: 'health → blood/knee/back/arm/peanut' },
  { query: 'my nighttime habits', expectedIndex: [10, 45, 73], type: 'semantic', description: 'nighttime → reading/journal/white noise' },
  { query: 'my education plans', expectedIndex: [11, 71], type: 'semantic', description: 'education → MBA / bootcamp' },
  { query: 'my investment losses', expectedIndex: 12, type: 'semantic', description: 'investment → crypto' },
  { query: 'self improvement efforts', expectedIndex: [13, 37, 47, 54], type: 'semantic', description: 'self improve → Spanish/mentor/guitar/screen' },
  { query: 'my love story', expectedIndex: [14, 58], type: 'semantic', description: 'love → dating app / propose' },
  { query: 'my work setup', expectedIndex: [15, 53], type: 'semantic', description: 'work setup → ThinkPad / standing desk' },
  { query: 'my weekly exercise', expectedIndex: [16, 25, 42, 60], type: 'semantic', description: 'exercise → basketball/marathon/gym/5K' },
  { query: "what I'm reading lately", expectedIndex: 17, type: 'semantic', description: 'reading → Sapiens' },
  { query: 'past medical procedures', expectedIndex: 18, type: 'semantic', description: 'medical → knee surgery' },
  { query: 'my employer', expectedIndex: 19, type: 'semantic', description: 'employer → Microsoft' },
  { query: 'important family dates', expectedIndex: [20, 58], type: 'semantic', description: 'family dates → Mar 15 / propose Sept' },
  { query: 'my tech stack preferences', expectedIndex: 21, type: 'semantic', description: 'tech stack → Python' },
  { query: 'my monthly expenses', expectedIndex: [22, 46, 57], type: 'semantic', description: 'expenses → mortgage/insurance/streaming' },
  { query: 'my wellness practices', expectedIndex: [23, 35, 64], type: 'semantic', description: 'wellness → meditation/fasting/supplements' },
  { query: "my family's locations", expectedIndex: [24, 44, 61], type: 'semantic', description: 'family loc → Chicago/Seattle/Portland' },
  { query: 'my fitness goals', expectedIndex: [25, 42, 60], type: 'semantic', description: 'fitness → marathon/gym/5K' },
  { query: 'my phone choice', expectedIndex: 26, type: 'semantic', description: 'phone → Android' },
  { query: 'my pets', expectedIndex: [27, 72], type: 'semantic', description: 'pets → cats / puppy waitlist' },
  { query: 'my dining preferences', expectedIndex: [28, 52, 70], type: 'semantic', description: 'dining → Italian/Thai/hot sauce' },
  { query: 'chronic health issues', expectedIndex: [29, 18], type: 'semantic', description: 'chronic → back pain / knee' },
  { query: 'my community involvement', expectedIndex: [30, 51], type: 'semantic', description: 'community → food bank / Red Cross' },
  { query: 'my work environment', expectedIndex: [31, 37], type: 'semantic', description: 'work env → team 8 / mentoring' },
  { query: 'my daily commute', expectedIndex: 32, type: 'semantic', description: 'daily commute → train' },
  { query: 'major financial decisions ahead', expectedIndex: [33, 65], type: 'semantic', description: 'financial → house / Tesla' },
  { query: 'closest friendships', expectedIndex: 34, type: 'semantic', description: 'friendships → Dave' },
  { query: 'my eating habits', expectedIndex: [35, 43, 40], type: 'semantic', description: 'eating → IF/vegetarian/oat milk' },
  { query: 'best travel memories', expectedIndex: 36, type: 'semantic', description: 'travel memories → Bali' },
  { query: 'my leadership role', expectedIndex: [37, 66], type: 'semantic', description: 'leadership → mentoring / coaching' },
  { query: 'upcoming work milestones', expectedIndex: 38, type: 'semantic', description: 'milestones → review Dec' },
  { query: 'my hobby projects', expectedIndex: [39, 47], type: 'semantic', description: 'hobby → recipe app / guitar' },

  // New 60 semantic
  { query: 'what don\'t I eat', expectedIndex: [43, 1, 62], type: 'semantic', description: 'don\'t eat → vegetarian/shellfish/peanut' },
  { query: 'my fears and anxieties', expectedIndex: [6, 50, 77], type: 'semantic', description: 'fears → heights/spiders/public speaking' },
  { query: 'tell me about my family', expectedIndex: [24, 44, 61, 20, 66], type: 'semantic', description: 'family → mom/sister/brother/daughter' },
  { query: 'my health history', expectedIndex: [18, 29, 55, 9, 62], type: 'semantic', description: 'health hist → knee/back/arm/blood/peanut' },
  { query: 'what have I been doing recently', expectedIndex: [13, 17, 25, 47, 58], type: 'semantic', description: 'recently → Spanish/Sapiens/marathon/guitar/propose' },
  { query: 'all my recurring expenses', expectedIndex: [22, 46, 57], type: 'semantic', description: 'recurring $ → mortgage/insurance/streaming' },
  { query: 'my relationship milestones', expectedIndex: [14, 58], type: 'semantic', description: 'relationship → met wife / proposing' },
  { query: 'what I do for exercise', expectedIndex: [16, 25, 42, 60], type: 'semantic', description: 'exercise → basketball/marathon/gym/5K' },
  { query: 'things I do every day', expectedIndex: [0, 23, 35, 42, 45, 64], type: 'semantic', description: 'daily → wake/meditate/fast/gym/journal/supps' },
  { query: 'my entertainment and media', expectedIndex: [41, 57, 63, 75], type: 'semantic', description: 'entertainment → BB/streaming/Radiohead/Shawshank' },
  { query: 'dairy-free choices', expectedIndex: [40, 79], type: 'semantic', description: 'dairy free → oat milk / flat white oat' },
  { query: 'things that annoy me', expectedIndex: [50, 56], type: 'semantic', description: 'annoy → spiders / neighbor dog' },
  { query: 'my learning journey', expectedIndex: [13, 47, 71], type: 'semantic', description: 'learning → Spanish/guitar/bootcamp' },
  { query: 'my sleep routine', expectedIndex: [10, 45, 73], type: 'semantic', description: 'sleep → read/journal/white noise' },
  { query: 'bad experiences I\'ve had', expectedIndex: [50, 68, 74, 12], type: 'semantic', description: 'bad exp → spiders/driving/sushi/crypto' },
  { query: 'people I care about', expectedIndex: [14, 24, 34, 44, 61], type: 'semantic', description: 'people → wife/mom/Dave/sister/brother' },
  { query: 'how I give back to others', expectedIndex: [30, 37, 51, 66], type: 'semantic', description: 'give back → food bank/mentor/donate/coach' },
  { query: 'my cooking skills', expectedIndex: 59, type: 'semantic', description: 'cooking → grandma pasta' },
  { query: 'my digital tools and apps', expectedIndex: [48, 15], type: 'semantic', description: 'digital tools → Notion / ThinkPad' },
  { query: 'what I watch on TV', expectedIndex: [41, 57], type: 'semantic', description: 'watch TV → Breaking Bad / streaming' },
  { query: 'injuries and accidents', expectedIndex: [18, 29, 55], type: 'semantic', description: 'injuries → knee/back/arm' },
  { query: 'my body modifications', expectedIndex: 67, type: 'semantic', description: 'body mod → compass tattoo' },
  { query: 'things I failed at', expectedIndex: [12, 68], type: 'semantic', description: 'failures → crypto loss / driving test' },
  { query: 'my savings and investments', expectedIndex: [65, 76, 12], type: 'semantic', description: 'savings → Tesla/401k/crypto' },
  { query: 'musical interests', expectedIndex: [47, 63], type: 'semantic', description: 'music → guitar / Radiohead' },
  { query: 'animals in my life', expectedIndex: [27, 72, 56], type: 'semantic', description: 'animals → cats/puppy/neighbor dog' },
  { query: 'my childhood memories', expectedIndex: [49, 50, 59], type: 'semantic', description: 'childhood → astronaut/spiders/grandma' },
  { query: 'how I relax at night', expectedIndex: [10, 45, 73], type: 'semantic', description: 'relax night → read/journal/white noise' },
  { query: 'my favorite foods', expectedIndex: [52, 70, 59], type: 'semantic', description: 'fav food → Thai/burrito/pasta' },
  { query: 'technology I use daily', expectedIndex: [15, 26, 48], type: 'semantic', description: 'tech daily → ThinkPad/Android/Notion' },
  { query: 'my weekend activities', expectedIndex: [4, 30, 44], type: 'semantic', description: 'weekend → son soccer/food bank/FaceTime' },
  { query: 'my professional background', expectedIndex: [3, 19, 71], type: 'semantic', description: 'professional → promoted/Microsoft/bootcamp' },
  { query: 'my guilty pleasures', expectedIndex: [70, 57], type: 'semantic', description: 'guilty pleasures → hot sauce / streaming' },
  { query: 'home office setup', expectedIndex: [15, 53], type: 'semantic', description: 'home office → ThinkPad / standing desk' },
  { query: 'future plans and goals', expectedIndex: [7, 25, 33, 58, 65], type: 'semantic', description: 'future → Italy/marathon/house/propose/Tesla' },
  { query: 'dietary supplements and health', expectedIndex: [64, 35, 43], type: 'semantic', description: 'supplements → vitamins/fasting/vegetarian' },
  { query: 'my coffee preferences', expectedIndex: 79, type: 'semantic', description: 'coffee → flat white oat milk' },
  { query: 'embarrassing moments', expectedIndex: 68, type: 'semantic', description: 'embarrassing → failed driving test' },
  { query: 'my charitable side', expectedIndex: [30, 51], type: 'semantic', description: 'charitable → food bank / Red Cross' },
  { query: 'movies and shows I love', expectedIndex: [41, 75], type: 'semantic', description: 'movies/shows → Breaking Bad / Shawshank' },
  { query: 'new skills I\'m developing', expectedIndex: [13, 47], type: 'semantic', description: 'new skills → Spanish / guitar' },
  { query: 'where do my relatives live', expectedIndex: [24, 44, 61], type: 'semantic', description: 'relatives → Chicago/Seattle/Portland' },
  { query: 'my spicy food preference', expectedIndex: [52, 70], type: 'semantic', description: 'spicy → Thai / hot sauce burrito' },
  { query: 'DIY projects I\'ve done', expectedIndex: [39, 78], type: 'semantic', description: 'DIY → recipe app / treehouse' },
  { query: 'things I\'m waiting for', expectedIndex: [72, 58, 65], type: 'semantic', description: 'waiting → puppy/propose/Tesla' },
  { query: 'how I stay healthy', expectedIndex: [23, 25, 35, 42, 43, 60, 64], type: 'semantic', description: 'stay healthy → meditate/run/fast/gym/veg/5K/supps' },
  { query: 'my biggest regrets', expectedIndex: [12, 68], type: 'semantic', description: 'regrets → crypto / driving test' },
  { query: 'what scares me', expectedIndex: [6, 50, 77], type: 'semantic', description: 'scares → heights/spiders/speaking' },
  { query: 'building things with my hands', expectedIndex: [59, 78], type: 'semantic', description: 'hands → pasta / treehouse' },
  { query: 'my productivity tools', expectedIndex: [48, 15, 53], type: 'semantic', description: 'productivity → Notion/ThinkPad/standing desk' },
  { query: 'my noise sensitivity', expectedIndex: [56, 73], type: 'semantic', description: 'noise → neighbor dog / white noise' },
  { query: 'who am I mentoring or coaching', expectedIndex: [37, 66], type: 'semantic', description: 'mentor/coach → juniors / daughter team' },
  { query: 'how much do I spend monthly', expectedIndex: [22, 46, 57], type: 'semantic', description: 'monthly spend → mortgage/insurance/streaming' },
  { query: 'things I do for fun on weekdays', expectedIndex: [16, 47], type: 'semantic', description: 'weekday fun → basketball / guitar' },
  { query: 'my plant-based lifestyle', expectedIndex: [40, 43, 79], type: 'semantic', description: 'plant-based → oat milk/vegetarian/flat white' },
  { query: 'my life insurance and safety', expectedIndex: [46, 62], type: 'semantic', description: 'insurance/safety → Geico / EpiPen' },
  { query: 'food that made me sick', expectedIndex: 74, type: 'semantic', description: 'sick food → sushi food poisoning' },
  { query: 'my art and creative pursuits', expectedIndex: [47, 39], type: 'semantic', description: 'creative → guitar / recipe app' },
  { query: 'things about my physical appearance', expectedIndex: 67, type: 'semantic', description: 'appearance → compass tattoo' },
  { query: 'my retirement planning', expectedIndex: 76, type: 'semantic', description: 'retirement → 401k maxed' },
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
  console.log(`  80 memories × 200 queries (100 direct + 100 semantic)`)
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
    console.log(`${mark} [${tc.type.padEnd(8)}] ${tc.description.padEnd(40)} | ${tc.query}`)
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
    console.log(`  ── Failed cases (${failures.length}) ──`)
    for (const f of failures) {
      console.log(`  ❌ [${f.type}] ${f.desc}: "${f.query}"`)
      console.log(`     Got: ${f.got.join(' | ')}`)
    }
  }
}

runBenchmark()
