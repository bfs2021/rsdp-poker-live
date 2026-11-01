// Free text and ids in settings. State is saved as Postgres jsonb, which
// refuses NUL and lone UTF-16 surrogates anywhere in the document.

/** Text safe to show and to store: no control characters or lone surrogates, trimmed. */
export function cleanText(text: string): string {
  return text
    .replace(/\p{Cs}/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .trim();
}

/** Whether any string or key in a JSON value holds something jsonb refuses. */
export function hasUnstorableText(value: unknown): boolean {
  if (typeof value === 'string') return /[\u0000\p{Cs}]/u.test(value);
  if (Array.isArray(value)) return value.some(hasUnstorableText);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([k, v]) => hasUnstorableText(k) || hasUnstorableText(v));
}

/** Longest game id: real ones are a few letters, and a longer one would only be stored and echoed back. */
const MAX_ID_LENGTH = 40;

export const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
