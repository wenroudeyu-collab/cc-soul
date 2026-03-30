/**
 * hook-handlers.ts — Hook event handlers for cc-soul plugin
 *
 * These functions are registered via api.registerHook() in plugin-entry.ts.
 * They handle message:preprocessed (augment injection), message:sent (fallback
 * post-response), and command:new (state persistence).
 *
 * The heavy lifting is delegated to handler.ts's extracted functions.
 */

import { flushAll } from './persistence.ts'
import { isContextEngineActive } from './context-engine.ts'

/**
 * message:preprocessed — augment injection, cognition, memory recall.
 * This is the main per-message processing hook.
 */
export async function onMessagePreprocessed(event: any): Promise<void> {
  // Delegate to handler.ts's extracted function
  const { handlePreprocessed } = await import('./handler.ts')
  await handlePreprocessed(event)
}

/**
 * message:sent — post-response analysis (fallback when CE afterTurn not available).
 * When Context Engine is active, afterTurn() handles this — skip here to avoid double processing.
 */
export async function onMessageSent(event: any): Promise<void> {
  const ceActive = isContextEngineActive()
  console.log(`[cc-soul][hook] message:sent fired (CE active: ${ceActive})`)
  // Always call handleSent — CE's afterTurn() may not fire reliably
  const { handleSent } = await import('./handler.ts')
  handleSent(event)
}

/**
 * command:new — flush all state to disk on session end.
 */
export async function onCommandNew(event: any): Promise<void> {
  const { handleCommand } = await import('./handler.ts')
  handleCommand(event)
}
