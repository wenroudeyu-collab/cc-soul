/**
 * embedder.ts — Stub (vector search retired)
 *
 * cc-soul's activation field engine (activation-field.ts) handles all recall
 * including semantic matching via AAM learned associations.
 * Vector embeddings are no longer needed.
 *
 * This file exports no-op stubs so existing callers don't break.
 */

export async function initEmbedder(): Promise<boolean> { return false }
export async function embed(_text: string): Promise<null> { return null }
export async function embedBatch(_texts: string[]): Promise<null[]> { return _texts.map(() => null) }
export function isEmbedderReady(): boolean { return false }
export function getEmbedDim(): number { return 0 }
export function getVectorStatus() { return { installed: false, hasModel: false, hasRuntime: false, ready: false } }
export async function installVectorSearch(_onProgress: (msg: string) => void): Promise<boolean> {
  _onProgress('向量搜索已退役。cc-soul 的激活场引擎已覆盖语义匹配，不再需要向量模型。')
  return false
}
