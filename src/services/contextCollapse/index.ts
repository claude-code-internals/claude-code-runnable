export function isContextCollapseEnabled(): boolean {
  return false
}

export async function applyCollapsesIfNeeded(
  messages: unknown[],
  ..._args: unknown[]
): Promise<{ messages: unknown[] }> {
  return { messages }
}

export function recoverFromOverflow(
  ..._args: unknown[]
): { committed: number } | null {
  return null
}

export function isWithheldPromptTooLong(
  ..._args: unknown[]
): boolean {
  return false
}

export function resetContextCollapse(): void {}

export function getStats(): { health: Record<string, unknown> } {
  return { health: {} }
}

export default {
  isContextCollapseEnabled,
  applyCollapsesIfNeeded,
  recoverFromOverflow,
  isWithheldPromptTooLong,
  resetContextCollapse,
  getStats,
}
