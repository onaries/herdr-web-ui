/** Devin's recorded ACP blocks retain the user's input before skill expansion. */
export function devinUserText(content: string, metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null || !("extensions" in metadata)) return content;
  const extensions = metadata.extensions;
  if (typeof extensions !== "object" || extensions === null || !("chisel/acp-content-blocks" in extensions)) return content;
  const blocks = extensions["chisel/acp-content-blocks"];
  if (!Array.isArray(blocks) || blocks.length !== 1) return content;
  const block: unknown = blocks[0];
  if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text" || !("text" in block) || typeof block.text !== "string") return content;
  return /^\/[\p{L}\p{N}_:-]+(?:\s|$)/u.test(block.text) ? block.text : content;
}
