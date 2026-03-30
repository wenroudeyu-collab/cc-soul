/**
 * embedder.ts — Local embedding with auto-detection of onnxruntime-node
 *
 * Zero required dependencies. If onnxruntime-node is installed,
 * loads all-MiniLM-L6-v2 (384 dimensions) for semantic vector search.
 * If not installed, all functions gracefully return null — callers
 * fall back to tag/trigram/BM25 matching.
 *
 * Install: npm i onnxruntime-node  (optional, ~40MB)
 * Model:   auto-downloaded on first use (~80MB, cached in DATA_DIR/models/)
 */

import { resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { DATA_DIR } from './persistence.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Share state across jiti module instances via globalThis
const _ge = (globalThis as any).__ccSoulEmbedder || ((globalThis as any).__ccSoulEmbedder = { ort: null, session: null, tokenizer: null, ready: false, initAttempted: false })
let ort: any = _ge.ort
let session: any = _ge.session
let tokenizer: any = _ge.tokenizer
let ready: boolean = _ge.ready
let initAttempted: boolean = _ge.initAttempted
function _syncEmbedder() { _ge.ort = ort; _ge.session = session; _ge.tokenizer = tokenizer; _ge.ready = ready; _ge.initAttempted = initAttempted }
function _loadEmbedder() { ort = _ge.ort; session = _ge.session; tokenizer = _ge.tokenizer; ready = _ge.ready; initAttempted = _ge.initAttempted }

const MODEL_DIR = resolve(DATA_DIR, 'models/minilm')
const MODEL_PATH = resolve(MODEL_DIR, 'model.onnx')
const VOCAB_PATH = resolve(MODEL_DIR, 'vocab.json')
const EMBED_DIM = 384

// ═══════════════════════════════════════════════════════════════════════════════
// INIT — try to load onnxruntime-node, fail silently if not installed
// ═══════════════════════════════════════════════════════════════════════════════

export async function initEmbedder(): Promise<boolean> {
  if (initAttempted) return ready
  initAttempted = true

  // Step 1: try loading onnxruntime-node (multiple approaches for jiti/ESM compat)
  const _req = typeof require !== 'undefined' ? require : null
  if (_req) {
    try { ort = _req('onnxruntime-node') } catch {}
  }
  if (!ort) {
    // createRequire with multiple anchors (same pattern as sqlite-store.ts)
    let metaUrl: string | undefined
    try { metaUrl = new Function('return import.meta.url')() } catch {}
    const anchors = [
      typeof __filename !== 'undefined' ? __filename : undefined,
      metaUrl,
      process.argv[1],
      process.execPath,
    ].filter(Boolean)
    for (const anchor of anchors) {
      try {
        const req = createRequire(anchor as string)
        ort = req('onnxruntime-node')
        if (ort) break
      } catch {}
    }
  }
  if (!ort) {
    // Last resort: try direct path
    const directPath = resolve(DATA_DIR, '../node_modules/onnxruntime-node')
    if (existsSync(directPath)) {
      try {
        const req = createRequire(resolve(directPath, 'package.json'))
        ort = req('onnxruntime-node')
      } catch {}
    }
  }
  if (!ort) {
    console.log('[cc-soul][embedder] onnxruntime-node not installed — vector search disabled (install with: npm i onnxruntime-node)')
    _syncEmbedder()
    return false
  }

  // Step 2: check if model files exist
  if (!existsSync(MODEL_PATH) || !existsSync(VOCAB_PATH)) {
    console.log(`[cc-soul][embedder] model not found at ${MODEL_DIR} — run "cc-soul download-model" or place model.onnx + vocab.json there`)
    console.log('[cc-soul][embedder] falling back to tag/trigram search')
    _syncEmbedder()
    return false
  }

  // Step 3: load model + tokenizer
  try {
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    })

    const vocabRaw = JSON.parse(readFileSync(VOCAB_PATH, 'utf-8'))
    tokenizer = buildTokenizer(vocabRaw)

    ready = true
    _syncEmbedder()
    console.log(`[cc-soul][embedder] ready — all-MiniLM-L6-v2 (${EMBED_DIM}d, CPU)`)
    return true
  } catch (e: any) {
    console.error(`[cc-soul][embedder] failed to load model: ${e.message}`)
    initAttempted = false // allow retry on next call
    _syncEmbedder()
    return false
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMBED — generate embedding vector for a text string
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate embedding vector for text. Returns Float32Array(384) or null if not available.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  _loadEmbedder()
  if (!ready || !session || !tokenizer) return null

  try {
    const tokens = tokenizer.encode(text, 128) // max 128 tokens
    const inputIds = new BigInt64Array(tokens.ids.map((id: number) => BigInt(id)))
    const attentionMask = new BigInt64Array(tokens.mask.map((m: number) => BigInt(m)))
    const tokenTypeIds = new BigInt64Array(tokens.ids.length).fill(0n)

    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, tokens.ids.length]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, tokens.ids.length]),
      token_type_ids: new ort.Tensor('int64', tokenTypeIds, [1, tokens.ids.length]),
    }

    const results = await session.run(feeds)

    // Model output: last_hidden_state [1, seq_len, 384] → mean pooling
    const output = results['last_hidden_state'] || results[Object.keys(results)[0]]
    const data = output.data as Float32Array
    const seqLen = tokens.ids.length

    // Mean pooling with attention mask
    const pooled = new Float32Array(EMBED_DIM)
    let maskSum = 0
    for (let i = 0; i < seqLen; i++) {
      const m = tokens.mask[i]
      maskSum += m
      if (m === 0) continue
      for (let j = 0; j < EMBED_DIM; j++) {
        pooled[j] += data[i * EMBED_DIM + j]
      }
    }
    if (maskSum > 0) {
      for (let j = 0; j < EMBED_DIM; j++) pooled[j] /= maskSum
    }

    // L2 normalize
    let norm = 0
    for (let j = 0; j < EMBED_DIM; j++) norm += pooled[j] * pooled[j]
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let j = 0; j < EMBED_DIM; j++) pooled[j] /= norm
    }

    return pooled
  } catch (e: any) {
    console.error(`[cc-soul][embedder] embed failed: ${e.message}`)
    return null
  }
}

/**
 * Batch embed multiple texts. More efficient than calling embed() in a loop.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (!ready) return texts.map(() => null)
  // Run sequentially to avoid OOM on CPU — ONNX CPU inference is already fast per-item
  const results: (Float32Array | null)[] = []
  for (const text of texts) {
    results.push(await embed(text))
  }
  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════════════

export function isEmbedderReady(): boolean {
  _loadEmbedder()
  return ready
}

export function getEmbedDim(): number {
  return EMBED_DIM
}

/**
 * Check vector search installation status.
 */
export function getVectorStatus(): { installed: boolean; hasModel: boolean; hasRuntime: boolean; ready: boolean } {
  const hasModel = existsSync(MODEL_PATH) && existsSync(VOCAB_PATH)
  let hasRuntime = false
  try {
    const _req = typeof require !== 'undefined' ? require : null
    if (_req) { _req.resolve('onnxruntime-node'); hasRuntime = true }
  } catch {}
  if (!hasRuntime) {
    const onnxPath = resolve(DATA_DIR, '../node_modules/onnxruntime-node/package.json')
    hasRuntime = existsSync(onnxPath)
  }
  // Auto-init if installed but not ready
  if (hasModel && hasRuntime && !ready) {
    initEmbedder().catch(() => {})
  }
  return { installed: hasModel && hasRuntime, hasModel, hasRuntime, ready }
}

/**
 * Auto-install vector search: download model + install onnxruntime-node.
 * Returns progress messages via callback.
 */
export async function installVectorSearch(onProgress: (msg: string) => void): Promise<boolean> {
  const status = getVectorStatus()
  if (status.installed) {
    onProgress('向量搜索已安装，无需重复操作。')
    if (!ready) {
      onProgress('正在初始化...')
      await initEmbedder()
    }
    onProgress(ready ? '✅ 向量搜索已启用' : '⚠️ 模型加载失败，请检查日志')
    return ready
  }

  // Download model files
  if (!status.hasModel) {
    onProgress('📦 下载模型文件（~80MB）...')
    if (!existsSync(MODEL_DIR)) mkdirSync(MODEL_DIR, { recursive: true })
    try {
      const https = await import('https')
      const downloadFile = (url: string, dest: string): Promise<void> => new Promise((resolve, reject) => {
        const { request } = https.default || https
        const doRequest = (u: string) => {
          request(u, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              doRequest(res.headers.location)
              return
            }
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => { writeFileSync(dest, Buffer.concat(chunks)); resolve() })
            res.on('error', reject)
          }).end()
        }
        doRequest(url)
      })
      await downloadFile('https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx', MODEL_PATH)
      onProgress('  ✅ model.onnx 下载完成')
      await downloadFile('https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json', VOCAB_PATH)
      onProgress('  ✅ vocab.json 下载完成')
    } catch (e: any) {
      onProgress(`  ❌ 下载失败: ${e.message}`)
      return false
    }
  }

  // Install onnxruntime-node
  if (!status.hasRuntime) {
    onProgress('📦 安装 onnxruntime-node（~40MB）...')
    try {
      const { execSync } = await import('child_process')
      const pluginDir = resolve(DATA_DIR, '..')
      execSync('npm i onnxruntime-node --save --silent', { cwd: pluginDir, timeout: 120000, stdio: 'pipe' })
      onProgress('  ✅ onnxruntime-node 安装完成')
    } catch (e: any) {
      onProgress(`  ❌ 安装失败: ${e.message}`)
      return false
    }
  }

  // Initialize
  onProgress('🔄 初始化向量引擎...')
  initAttempted = false // reset so initEmbedder retries
  const ok = await initEmbedder()
  onProgress(ok ? '✅ 向量搜索安装完成！重启 gateway 后生效。' : '⚠️ 安装完成但初始化失败，请重启 gateway。')
  return ok
}

// ═══════════════════════════════════════════════════════════════════════════════
// MINIMAL WORDPIECE TOKENIZER — no dependencies, just vocab.json
// ═══════════════════════════════════════════════════════════════════════════════

interface SimpleTokenizer {
  encode(text: string, maxLen: number): { ids: number[]; mask: number[] }
}

function buildTokenizer(vocab: Record<string, number>): SimpleTokenizer {
  const CLS = vocab['[CLS]'] ?? 101
  const SEP = vocab['[SEP]'] ?? 102
  const PAD = vocab['[PAD]'] ?? 0
  const UNK = vocab['[UNK]'] ?? 100

  function tokenize(text: string): number[] {
    // Basic pre-tokenization: lowercase, split on whitespace and punctuation
    const words = text.toLowerCase()
      .replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, ' $& ') // space around CJK
      .split(/\s+/)
      .filter(w => w.length > 0)

    const ids: number[] = []
    for (const word of words) {
      // WordPiece tokenization
      let remaining = word
      let isFirst = true
      while (remaining.length > 0) {
        let matched = ''
        let matchedId = UNK
        // Greedy longest-match
        for (let end = remaining.length; end > 0; end--) {
          const sub = isFirst ? remaining.slice(0, end) : '##' + remaining.slice(0, end)
          if (vocab[sub] !== undefined) {
            matched = remaining.slice(0, end)
            matchedId = vocab[sub]
            break
          }
        }
        if (matched.length === 0) {
          // Single char fallback
          ids.push(UNK)
          remaining = remaining.slice(1)
        } else {
          ids.push(matchedId)
          remaining = remaining.slice(matched.length)
        }
        isFirst = false
      }
    }
    return ids
  }

  return {
    encode(text: string, maxLen: number) {
      let tokens = tokenize(text)
      // Truncate (leave room for CLS + SEP)
      if (tokens.length > maxLen - 2) tokens = tokens.slice(0, maxLen - 2)
      const ids = [CLS, ...tokens, SEP]
      const mask = ids.map(() => 1)
      // Pad to maxLen
      while (ids.length < maxLen) {
        ids.push(PAD)
        mask.push(0)
      }
      return { ids, mask }
    },
  }
}
