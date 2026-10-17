import { describe, expect, it } from "vitest";
import {
  buildGtin13,
  buildProvisionalGtin13,
  calculateChecksum,
  formatGtinDisplay,
  formatItemId,
  formatProvisionalDisplay,
  isProvisionalGtin13,
  parseProvisionalSequence,
} from "../index";

describe("calculateChecksum", () => {
  it("calculateChecksum_returns_correct_digit_for_known_input", () => {
    expect(calculateChecksum("400638133393")).toBe(1);
  });

  it("calculateChecksum_returns_0_when_remainder_is_0", () => {
    expect(calculateChecksum("000000000000")).toBe(0);
  });

  it("calculateChecksum_is_consistent_with_buildGtin13_output", () => {
    for (const [letter, sub, seq] of [["A", 1, 1], ["M", 50, 500], ["Z", 99, 9998]] as const) {
      const gtin = buildGtin13(letter, sub, seq);
      expect(calculateChecksum(gtin.slice(0, 12))).toBe(parseInt(gtin[12], 10));
    }
  });
});

describe("buildGtin13", () => {
  it("buildGtin13_encodes_A_category_sub1_seq1_to_expected_string", () => {
    const partial = "020001010001";
    expect(buildGtin13("A", 1, 1)).toBe(partial + calculateChecksum(partial));
  });

  it("buildGtin13_encodes_Z_category_sub99_seq9998_to_expected_string", () => {
    const partial = "020099269998";
    expect(buildGtin13("Z", 99, 9998)).toBe(partial + calculateChecksum(partial));
  });

  it("buildGtin13_produces_13_digit_string", () => {
    expect(buildGtin13("B", 5, 42)).toHaveLength(13);
  });

  it("buildGtin13_produced_gtin13_passes_checksum_verification", () => {
    const gtin = buildGtin13("C", 3, 7);
    expect(calculateChecksum(gtin.slice(0, 12))).toBe(parseInt(gtin[12], 10));
  });

  it("buildGtin13_accepts_lowercase_letter", () => {
    expect(buildGtin13("a", 1, 1)).toBe(buildGtin13("A", 1, 1));
  });
});

describe("buildProvisionalGtin13", () => {
  it("buildProvisionalGtin13_encodes_sequence_1_correctly", () => {
    const partial = "020000270001";
    expect(buildProvisionalGtin13(1)).toBe(partial + calculateChecksum(partial));
  });

  it("buildProvisionalGtin13_encodes_sequence_999999_correctly", () => {
    const partial = "020099279999";
    expect(buildProvisionalGtin13(999999)).toBe(partial + calculateChecksum(partial));
  });

  it("buildProvisionalGtin13_produces_13_digit_string", () => {
    expect(buildProvisionalGtin13(42)).toHaveLength(13);
  });

  it("buildProvisionalGtin13_produced_gtin13_passes_checksum_verification", () => {
    const gtin = buildProvisionalGtin13(100);
    expect(calculateChecksum(gtin.slice(0, 12))).toBe(parseInt(gtin[12], 10));
  });
});

describe("isProvisionalGtin13", () => {
  it("returns_true_for_provisional_gtin", () => {
    expect(isProvisionalGtin13(buildProvisionalGtin13(1))).toBe(true);
  });

  it("returns_false_for_catalog_gtin", () => {
    expect(isProvisionalGtin13(buildGtin13("A", 1, 1))).toBe(false);
  });

  it("returns_false_for_empty_string", () => {
    expect(isProvisionalGtin13("")).toBe(false);
  });

  it("returns_false_for_string_shorter_than_8_chars", () => {
    expect(isProvisionalGtin13("0200")).toBe(false);
  });

  it("returns_true_for_all_valid_provisional_sequences", () => {
    for (const seq of [1, 100, 9999, 999999]) {
      expect(isProvisionalGtin13(buildProvisionalGtin13(seq))).toBe(true);
    }
  });
});

describe("parseProvisionalSequence", () => {
  it("recovers_sequence_from_provisional_gtin", () => {
    const seq = 12345;
    expect(parseProvisionalSequence(buildProvisionalGtin13(seq))).toBe(seq);
  });

  it("throws_for_non_provisional_gtin", () => {
    expect(() => parseProvisionalSequence(buildGtin13("A", 1, 1))).toThrow("Not a provisional GTIN13");
  });
});

describe("formatProvisionalDisplay", () => {
  it("formats_sequence_1_as_P000001", () => {
    expect(formatProvisionalDisplay(buildProvisionalGtin13(1))).toBe("P000001");
  });

  it("formats_max_sequence_as_P999999", () => {
    expect(formatProvisionalDisplay(buildProvisionalGtin13(999999))).toBe("P999999");
  });

  it("throws_for_non_provisional_gtin13", () => {
    expect(() => formatProvisionalDisplay(buildGtin13("A", 1, 1))).toThrow();
  });
});

describe("formatGtinDisplay", () => {
  it("formats_provisional_as_P_plus_6_digit_sequence", () => {
    expect(formatGtinDisplay(buildProvisionalGtin13(1))).toBe("P000001");
    expect(formatGtinDisplay(buildProvisionalGtin13(999999))).toBe("P999999");
  });

  it("formats_standard_0200_gtin_as_subcategory_letter_sequence", () => {
    // subcategory=03, catPos=12 → letter=L, sequence=0001 → "03L0001"
    const STANDARD = "0200031200015";
    expect(formatGtinDisplay(STANDARD)).toBe("03L0001");
  });

  it("returns_raw_gtin_for_non_0200_codes", () => {
    expect(formatGtinDisplay("5901234123457")).toBe("5901234123457");
  });
});

describe("formatItemId", () => {
  it("formats_provisional_gtin_as_P_plus_padded_sequence", () => {
    expect(formatItemId(buildProvisionalGtin13(1))).toBe("P000001");
  });

  it("formats_catalog_gtin_as_subcategory_letter_sequence_compact", () => {
    // buildGtin13("A",1,1) → "020001010001X" → subPart="01", catPos=01→A, seqPart="0001"
    const gtin = buildGtin13("A", 1, 1);
    expect(formatItemId(gtin)).toBe("01A0001");
  });
});
