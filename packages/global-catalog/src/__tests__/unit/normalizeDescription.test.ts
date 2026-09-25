import { describe, expect, it } from "vitest";
import { normalizeDescription } from "../../lib/normalizeDescription";

describe("normalizeDescription", () => {
  it("normalizeDescription_lowercases_input", () => {
    expect(normalizeDescription("HELLO WORLD")).toBe("hello world");
  });

  it("normalizeDescription_trims_leading_and_trailing_whitespace", () => {
    expect(normalizeDescription("  hello  ")).toBe("hello");
  });

  it("normalizeDescription_collapses_internal_multiple_spaces_to_single_space", () => {
    expect(normalizeDescription("hello   world")).toBe("hello world");
  });

  it("normalizeDescription_handles_empty_string", () => {
    expect(normalizeDescription("")).toBe("");
  });

  it("normalizeDescription_handles_string_with_only_whitespace", () => {
    expect(normalizeDescription("   ")).toBe("");
  });

  it("normalizeDescription_preserves_punctuation_and_numbers", () => {
    expect(normalizeDescription("Part #42, Rev. B")).toBe("part #42, rev. b");
  });

  it("normalizeDescription_already_lowercase_input_is_returned_unchanged", () => {
    expect(normalizeDescription("hello world")).toBe("hello world");
  });

  it("normalizeDescription_collapses_tabs_and_newlines_to_single_space", () => {
    expect(normalizeDescription("hello\tworld\nfoo")).toBe("hello world foo");
  });

  it("normalizeDescription_lowercases_accented_unicode_characters", () => {
    expect(normalizeDescription("HÉLLO ÑOÑO")).toBe("héllo ñoño");
  });
});
