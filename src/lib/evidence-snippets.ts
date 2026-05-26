/**
 * Evidence-snippet extraction for the "View on PDF" feature.
 *
 * Given an Item's `evidence` field (free-form text the AI quoted from the
 * PDF when extracting the item), pull out the most distinctive search
 * tokens — the strings most likely to appear verbatim in the PDF text
 * layer. The viewer uses these to find and highlight matching text spans
 * inside the rendered page.
 *
 * Strategy (in priority order, capped at MAX_SNIPPETS total):
 *   1. STA references (e.g. "STA 058.01", "STA 1+55.31") — extremely
 *      distinctive, almost always appear verbatim on profile/plan callouts.
 *   2. Quoted substrings (e.g. "INSTALL: 1 - 8X8 TEE") — when the AI puts
 *      something in single quotes it's typically a direct PDF quote.
 *   3. Uppercase phrases of 3+ words (e.g. "PROP. 5X4 STORM @ 1.37%
 *      PRIVATE", "5X4 CONCRETE HEADWALL") — common civil-plan callout style.
 *
 * Pure function, no side effects, safe to call from client and server.
 */

const MAX_SNIPPETS = 6;
const MAX_SNIPPET_LENGTH = 60;

/**
 * Extract a short list of high-signal search tokens from an evidence string.
 * Returns an empty array if `evidence` is null/empty.
 */
export function extractEvidenceSnippets(evidence: string | null | undefined): string[] {
  if (!evidence || !evidence.trim()) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const trimmed = raw.trim().slice(0, MAX_SNIPPET_LENGTH);
    if (!trimmed || trimmed.length < 3) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(trimmed);
  };

  // 1. STA references — both "X+YY.ZZ" and decimal "NNN.MM" forms.
  const staMatches = evidence.matchAll(
    /STA\s*(?:\d+\+\d+(?:\.\d+)?|\d+\.\d+)/gi
  );
  for (const m of staMatches) {
    push(m[0]);
    if (found.length >= MAX_SNIPPETS) return found;
  }

  // 2. Quoted substrings (single quotes, e.g. 'CONNECT TO EX. SSMH').
  const quotedMatches = evidence.matchAll(/'([^']{3,60})'/g);
  for (const m of quotedMatches) {
    push(m[1]);
    if (found.length >= MAX_SNIPPETS) return found;
  }

  // 3. Uppercase phrases — 3+ tokens, mostly uppercase letters/digits/symbols.
  // Allow common embedded chars: ".", '"', "X" (as in 8X8), digits, slashes, %,
  // and stop at lowercase letters or sentence punctuation.
  const upperPhraseMatches = evidence.matchAll(
    /(?:[A-Z][A-Z0-9"'.\/%X#-]{1,15}(?:\s+|$)){3,}/g
  );
  for (const m of upperPhraseMatches) {
    push(m[0]);
    if (found.length >= MAX_SNIPPETS) return found;
  }

  return found;
}

/**
 * Encode a snippet list into a single URL search-param value (comma-joined,
 * each snippet URL-encoded so commas inside snippets don't collide).
 */
export function encodeSnippetsForUrl(snippets: string[]): string {
  return snippets.map((s) => encodeURIComponent(s)).join(",");
}

/**
 * Inverse of encodeSnippetsForUrl: decode a URL param value back to the
 * snippet list. Returns [] for empty/missing input. Robust to malformed
 * encoding (skips bad entries silently).
 */
export function decodeSnippetsFromUrl(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => {
      try {
        return decodeURIComponent(s).trim();
      } catch {
        return "";
      }
    })
    .filter((s) => s.length >= 3);
}
