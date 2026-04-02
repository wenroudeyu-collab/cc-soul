/**
 * Clean aam_synonyms.json by resetting it to _defaultSynonyms from source code.
 * PMI graduation polluted the file with 2-gram sliding window fragments.
 * Run: npx tsx scripts/clean-synonyms.ts
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AAM_PATH = resolve(__dirname, '../cc-soul/aam.ts')
const SYNONYMS_PATH = resolve(__dirname, '../data/aam_synonyms.json')

// Read current file for stats
const oldData = JSON.parse(readFileSync(SYNONYMS_PATH, 'utf-8'))
const oldKeyCount = Object.keys(oldData).length
let oldEntryCount = 0
for (const syns of Object.values(oldData) as string[][]) {
  oldEntryCount += syns.length
}

// Extract _defaultSynonyms from aam.ts source
const source = readFileSync(AAM_PATH, 'utf-8')
const startMarker = 'const _defaultSynonyms: Record<string, string[]> = {'
const startIdx = source.indexOf(startMarker)
if (startIdx === -1) throw new Error('Cannot find _defaultSynonyms in aam.ts')

// Find the matching closing brace
let braceDepth = 0
let endIdx = -1
for (let i = startIdx + startMarker.length - 1; i < source.length; i++) {
  if (source[i] === '{') braceDepth++
  else if (source[i] === '}') {
    braceDepth--
    if (braceDepth === 0) {
      endIdx = i + 1
      break
    }
  }
}
if (endIdx === -1) throw new Error('Cannot find closing brace for _defaultSynonyms')

const objectLiteral = source.slice(startIdx + startMarker.length - 1, endIdx)

// Convert TS object literal to JSON by evaluating it
// The object only contains string literals, so this is safe
const defaultSynonyms: Record<string, string[]> = new Function(`return ${objectLiteral}`)()

const newKeyCount = Object.keys(defaultSynonyms).length
let newEntryCount = 0
for (const syns of Object.values(defaultSynonyms)) {
  newEntryCount += syns.length
}

// Write cleaned file
writeFileSync(SYNONYMS_PATH, JSON.stringify(defaultSynonyms, null, 2) + '\n', 'utf-8')

console.log(`=== AAM Synonyms Cleanup ===`)
console.log(`Before: ${oldKeyCount} keys, ${oldEntryCount} entries`)
console.log(`After:  ${newKeyCount} keys, ${newEntryCount} entries`)
console.log(`Removed: ${oldKeyCount - newKeyCount} keys, ${oldEntryCount - newEntryCount} entries`)
console.log(`Written to: ${SYNONYMS_PATH}`)
