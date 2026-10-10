/**
 * Wire the receipt library into checkin (#1265 §3/§6), called once at server boot from
 * instrumentation.ts. Binding touches no database and no network: the principal and the org
 * are read lazily, inside a request. The S1 sink (X6), donor sink (X13) and reimbursement
 * status (X12) stay unbound, so the library's inert adapters queue or answer "not yet paid".
 */
import { configureReceipt, createAnthropicOcr, fixtureOcr, type ReceiptPrincipal } from "@inventory/receipt";
import { getOrg } from "@/lib/catalog/configure";
import { config } from "@/lib/config";

/**
 * The signed-in person as a receipt principal; null unless the session carries an integer id
 * that names a live Person. Names and adulthood come from the Person row: the uploader's
 * names fill "I am the donor", and only an adult may ask to be reimbursed.
 */
async function getPrincipal(): Promise<ReceiptPrincipal | null> {
  // Lazy: importing auth-options at boot would crash a Google-credless boot.
  const [{ getServerSession }, { authOptions }, { default: prisma }, { isKnownAdult }] = await Promise.all([
    import("next-auth"),
    import("@/lib/auth-options"),
    import("@/lib/prisma"),
    import("@/lib/programAge"),
  ]);
  const user = (await getServerSession(authOptions))?.user;
  if (!user || typeof user.id !== "number") return null;
  const person = await prisma.person.findFirst({
    where: { id: user.id, mergedIntoId: null },
    select: { name: true, dateOfBirth: true, isDeclaredAdult: true },
  });
  if (!person) return null;
  const [firstName = "", ...rest] = person.name.trim().split(/\s+/);
  return { id: user.id, name: person.name, firstName, lastName: rest.join(" "), isAdult: isKnownAdult(person) };
}

export function configureRuntime(): void {
  configureReceipt({
    auth: { getPrincipal },
    org: getOrg,
    // Chosen by CHECKIN_ENV, never by whether a key is set (fail closed): a deployed instance
    // without the key reads nothing and lands auto uploads in ocr_failed.
    ocr: config.checkinEnv() === "local" ? fixtureOcr : createAnthropicOcr(process.env.ANTHROPIC_API_KEY),
  });
}
