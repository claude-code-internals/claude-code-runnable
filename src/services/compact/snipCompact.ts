export function snipCompactIfNeeded(
  ..._args: unknown[]
): { messages: unknown[]; tokensFreed: number; boundaryMessage?: unknown } {
  return { messages: [], tokensFreed: 0 }
}

export default { snipCompactIfNeeded }
