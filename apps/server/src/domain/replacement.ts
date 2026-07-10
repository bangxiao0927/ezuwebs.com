export function createReplacementPrompt(basePrompt: string, rejectionReason: string): string {
  return [
    basePrompt,
    `Rejected because: ${rejectionReason.trim()}.`,
    "Redo the patch from scratch based on that rejection reason.",
    "Do not reuse the previous structure if it conflicts with the rejection reason.",
    "Make the replacement visibly address the cited issue instead of applying a generic template.",
  ].join(" ");
}
