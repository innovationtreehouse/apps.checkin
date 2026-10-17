/** A name write that can never blank a Person: a trimmed non-empty string, or undefined
 *  (meaning "leave the stored name alone"). */
export const nameWrite = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

/** True when `v` is a well-formed nickname write: a string, `null` to clear the
 *  nickname, or `undefined` to leave it alone. Routes 400 anything else — mapping a
 *  malformed value to null would let a buggy caller silently erase a stored nickname. */
export const isNicknameWrite = (v: unknown): v is string | null | undefined =>
    v === undefined || v === null || typeof v === "string";

/** A nickname write: a trimmed non-empty string, `null` to clear it, or `undefined`
 *  (meaning "leave the stored nickname alone"). Unlike a name, a nickname is optional,
 *  so an explicit blank clears it rather than being rejected. */
export const nicknameWrite = (v: string | null | undefined): string | null | undefined =>
    typeof v === "string" ? v.trim() || null : v;
