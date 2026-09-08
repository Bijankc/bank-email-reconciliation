/**
 * Small HTML helpers used where HTMLRewriter is the wrong tool - pulling a value
 * out of a sentence in a paragraph rather than out of a structured table.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => ENTITIES[match] ?? match);
}

/** Flatten markup to readable text. Not a renderer - just enough for a regex. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
