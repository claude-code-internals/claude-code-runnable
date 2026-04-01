export type CachedMCState = {
  registeredTools: Set<string>
  toolOrder: string[]
  deletedRefs: Set<string>
  pinnedEdits: PinnedCacheEdits[]
}
export type CacheEditsBlock = Record<string, unknown>
export type PinnedCacheEdits = { userMessageIndex: number; block: CacheEditsBlock }

export function createCachedMCState(): CachedMCState {
  return {
    registeredTools: new Set(),
    toolOrder: [],
    deletedRefs: new Set(),
    pinnedEdits: [],
  }
}

export function markToolsSentToAPI(_state: CachedMCState): void {}

export function resetCachedMCState(state: CachedMCState): void {
  state.registeredTools.clear()
  state.toolOrder.length = 0
  state.deletedRefs.clear()
  state.pinnedEdits.length = 0
}

export function isCachedMicrocompactEnabled(): boolean {
  return false
}

export function isModelSupportedForCacheEditing(_model: string): boolean {
  return false
}

export function getCachedMCConfig(): { triggerThreshold: number; keepRecent: number } {
  return { triggerThreshold: 0, keepRecent: 0 }
}

export function registerToolResult(_state: CachedMCState, _toolUseId: string): void {}

export function registerToolMessage(_state: CachedMCState, _groupIds: string[]): void {}

export function getToolResultsToDelete(_state: CachedMCState): string[] {
  return []
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  _toolIds: string[],
): CacheEditsBlock | null {
  return null
}

export default {
  createCachedMCState,
  markToolsSentToAPI,
  resetCachedMCState,
  isCachedMicrocompactEnabled,
  isModelSupportedForCacheEditing,
  getCachedMCConfig,
  registerToolResult,
  registerToolMessage,
  getToolResultsToDelete,
  createCacheEditsBlock,
}
