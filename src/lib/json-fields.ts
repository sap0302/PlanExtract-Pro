/**
 * Utilities for storing/reading JSON array fields in SQLite string columns.
 */

/**
 * Parse a JSON string column into a typed array.
 * Returns empty array on null, undefined, or invalid JSON.
 */
export function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Stringify an array for storage in a SQLite string column.
 * Returns null for empty or missing arrays.
 */
export function stringifyJsonArray<T>(arr: T[] | null | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr);
}
