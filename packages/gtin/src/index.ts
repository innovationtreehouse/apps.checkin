export function calculateChecksum(partial12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(partial12[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function buildGtin13(categoryLetter: string, subcategoryNumber: number, sequence: number): string {
  const catPos = categoryLetter.toUpperCase().charCodeAt(0) - 64; // A=1, B=2...
  const partial = "0200"
    + String(subcategoryNumber).padStart(2, "0")
    + String(catPos).padStart(2, "0")
    + String(sequence).padStart(4, "0");
  return partial + calculateChecksum(partial);
}

export function buildProvisionalGtin13(sequence: number): string {
  const seqStr = String(sequence).padStart(6, "0");
  const prefix = seqStr.substring(0, 2);
  const suffix = seqStr.substring(2);
  const partial = "0200" + prefix + "27" + suffix;
  return partial + calculateChecksum(partial);
}

export function isProvisionalGtin13(gtin13: string): boolean {
  return gtin13.startsWith("0200") && gtin13.substring(6, 8) === "27";
}

export function parseProvisionalSequence(gtin13: string): number {
  if (!isProvisionalGtin13(gtin13)) {
    throw new Error("Not a provisional GTIN13");
  }
  const prefix = gtin13.substring(4, 6);
  const suffix = gtin13.substring(8, 12);
  return parseInt(prefix + suffix, 10);
}

export function formatProvisionalDisplay(gtin13: string): string {
  const sequence = parseProvisionalSequence(gtin13);
  return "P" + String(sequence).padStart(6, "0");
}

export function formatGtinDisplay(gtin13: string): string {
  if (isProvisionalGtin13(gtin13)) {
    return formatProvisionalDisplay(gtin13);
  }
  if (gtin13.startsWith("0200")) {
    const subcategory = parseInt(gtin13.substring(4, 6), 10);
    const catPos = parseInt(gtin13.substring(6, 8), 10);
    const sequence = parseInt(gtin13.substring(8, 12), 10);
    const letter = String.fromCharCode(64 + catPos);
    return String(subcategory).padStart(2, "0") + letter + String(sequence).padStart(4, "0");
  }
  return gtin13;
}

export function formatItemId(gtin13: string): string {
  if (isProvisionalGtin13(gtin13)) {
    const sequence = parseProvisionalSequence(gtin13);
    return "P" + String(sequence).padStart(6, "0");
  }
  const subPart = gtin13.slice(4, 6);
  const catPos = parseInt(gtin13.slice(6, 8), 10);
  const catLetter = String.fromCharCode(64 + catPos);
  const seqPart = gtin13.slice(8, 12);
  return `${subPart}${catLetter}${seqPart}`;
}
