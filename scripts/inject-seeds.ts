/**
 * 将 seed-expansion.ts 的新增同义词注入到 aam.ts
 */
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)

const { NEW_SYNONYMS, NEW_CONCEPTS } = require('./seed-expansion.ts')

const aamPath = '/Users/z/.openclaw/plugins/cc-soul/cc-soul/aam.ts'
let src = readFileSync(aamPath, 'utf-8')

// 找到 _defaultSynonyms 的结尾（最后一个 } 之前）
// 在 "// ── 概念级近义" 注释前面插入新组
const insertMarker = "  // ── 概念级近义"
const insertPos = src.indexOf(insertMarker)

if (insertPos < 0) {
  // 找 COLD_START_SYNONYMS 的加载行前面
  const fallback = "let COLD_START_SYNONYMS"
  const fbPos = src.indexOf(fallback)
  if (fbPos < 0) { console.error('Cannot find insertion point'); process.exit(1) }
  // 在 _defaultSynonyms 的最后一个条目后面（倒退找最后一个 ],\n）
  console.error('Using fallback insertion point')
}

// 生成新增同义词代码
let newCode = '\n  // ── 冷启动种子扩展（自动生成，2000组目标）──────────────────────────\n'
for (const [key, values] of Object.entries(NEW_SYNONYMS)) {
  // 检查是否已存在
  if (src.includes(`'${key}':`)) {
    // 合并到现有条目
    continue  // 跳过已存在的 key
  }
  newCode += `  '${key}': [${values.map(v => `'${v}'`).join(', ')}],\n`
}

// 在 insertMarker 前插入
if (insertPos > 0) {
  src = src.slice(0, insertPos) + newCode + '\n' + src.slice(insertPos)
} else {
  console.error('Insertion point not found, skipping synonym injection')
}

// 注入 CONCEPT_HIERARCHY 新条目
for (const [key, children] of Object.entries(NEW_CONCEPTS)) {
  const conceptKey = `'${key}':`
  if (src.includes(`CONCEPT_HIERARCHY`) && src.includes(conceptKey)) {
    // 已存在，合并 children
    // 找到这个 key 的数组并追加新 children
    // 简化：跳过已存在的
    continue
  }
  // 在 CONCEPT_HIERARCHY 的 } 前插入
  const chEnd = src.indexOf("}\n", src.indexOf("const CONCEPT_HIERARCHY"))
  if (chEnd > 0) {
    const newEntry = `  '${key}': [${children.map(c => `'${c}'`).join(',')}],\n`
    src = src.slice(0, chEnd) + newEntry + src.slice(chEnd)
  }
}

writeFileSync(aamPath, src)

// 统计
const finalMatches = src.slice(0, src.indexOf('let COLD_START')).match(/'[^']+'\s*:\s*\[/g)
console.log(`注入完成。当前同义词组总数: ${finalMatches?.length || '?'}`)

const chBlock = src.slice(src.indexOf('const CONCEPT_HIERARCHY'), src.indexOf('}', src.indexOf('const CONCEPT_HIERARCHY') + 100) + 100)
const chKeys = chBlock.match(/'[^']+'\s*:\s*\[/g)
console.log(`当前概念层级总数: ${chKeys?.length || '?'}`)
