// PLACEHOLDER — no schema generates this yet. Replaced by the security generator
// once the donation library's schema carries a `generator security` block.

export const classifications = {
} as const;

export const relations = {
} as const;

export type Models = keyof typeof classifications;
export type FieldsOf<M extends Models> = keyof (typeof classifications)[M];
export type TierOf<M extends Models, F extends FieldsOf<M>> = (typeof classifications)[M][F];
