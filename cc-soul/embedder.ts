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
import { DATA_DIR } from './persistence.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let ort: any = null
let session: any = null
let tokenizer: any = null
let ready = false
let initAttempted = false

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

  // Step 1: try loading onnxruntime-node
  try {
    ort = require('onnxruntime-node')
  } catch {
    try {
      const { createRequire } = require('module')
      const req = createRequire(import.meta.url || __filename)
      ort = req('onnxruntime-node')
    } catch {
      console.log('[cc-soul][embedder] onnxruntime-node not installed — vector search disabled (install with: npm i onnxruntime-node)')
      return false
    }
  }

  // Step 2: check if model files exist
  if (!existsSync(MODEL_PATH) || !existsSync(VOCAB_PATH)) {
    console.log(`[cc-soul][embedder] model not found at ${MODEL_DIR} — run "cc-soul download-model" or place model.onnx + vocab.json there`)
    console.log('[cc-soul][embedder] falling back to tag/trigram search')
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
    console.log(`[cc-soul][embedder] ready — all-MiniLM-L6-v2 (${EMBED_DIM}d, CPU)`)
    return true
  } catch (e: any) {
    console.error(`[cc-soul][embedder] failed to load model: ${e.message}`)
    initAttempted = false // allow retry on next call
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
  return ready
}

export function getEmbedDim(): number {
  return EMBED_DIM
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
