// Approximate token count — 1 token ≈ 4 chars for English.
// Good enough for budget checks; not a tiktoken replacement.
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function approximateTokensForMessages(
  messages: Array<{ role: string; content: string }>
): number {
  return messages.reduce((sum, m) => sum + approximateTokens(m.content) + 4, 0);
}
