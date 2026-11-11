export type QuantityMethod = "use_provisional" | "use_existing" | "sum";

const METHODS: { value: QuantityMethod; label: string }[] = [
  { value: "use_existing", label: "Keep existing" },
  { value: "use_provisional", label: "Use provisional" },
  { value: "sum", label: "Sum both" },
];

/**
 * How a unit conflict may be resolved. A provisional holding no stock can't be the count to use:
 * that would set the real count to 0.
 */
export function methodsFor(provisionalQuantity: number) {
  return provisionalQuantity > 0 ? METHODS : METHODS.filter((m) => m.value !== "use_provisional");
}
