import { describe, expect, it } from "vitest";
import { seedCollision, type SeedColumns } from "../../lib/capital-register";

const row: SeedColumns = {
  parentAssetNumber: null,
  description: "Lathe",
  acquisitionDate: "2021-04-01",
  costCents: 120_000,
  depreciationYears: 7,
  sourceQbTxnId: "qb-1",
  sourceQbTxnEntity: "Bill",
};

describe("seedCollision", () => {
  it("lets an exact repeat of a seeded row through", () => {
    expect(seedCollision("ITFA01", { ...row, seeded: true }, row)).toBeNull();
  });

  it("refuses a number the app already issued, naming it", () => {
    expect(seedCollision("ITFA01", { ...row, seeded: false }, row)).toMatch(/^ITFA01 was already issued by the app/);
  });

  it("refuses a seeded number whose details differ, naming it", () => {
    expect(seedCollision("ITFA01", { ...row, seeded: true }, { ...row, costCents: 99 })).toMatch(/^ITFA01 was already issued and seeded/);
    expect(seedCollision("ITFA01", { ...row, seeded: true }, { ...row, description: "Drill press" })).not.toBeNull();
  });
});
