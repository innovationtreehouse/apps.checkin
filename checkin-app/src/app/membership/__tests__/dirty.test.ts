import { serializeMembershipForm } from "@/app/membership/membershipForm";

const base = {
  address: { line1: "1 A St", line2: "", city: "Austin", state: "TX", postalCode: "78701" },
  emName: "Jo", emPhone: "555", emEmail: "",
  primary: { name: "Pat", email: "", dob: "1990-01-01", over25: false, allergies: "" },
  hasSecondary: false,
  secondary: { id: undefined, name: "", email: "", dob: "", over25: false, allergies: "" },
  children: [{ id: 1, name: "Kid", email: "", dob: "2015-02-02", over25: false, allergies: "peanuts" }],
  notes: "",
};

describe("serializeMembershipForm (unsaved-changes dirty compare)", () => {
  it("identical values → equal key (clean form → not dirty)", () => {
    expect(serializeMembershipForm(base)).toBe(serializeMembershipForm({ ...base }));
  });

  it("a changed top-level field → different key (dirty)", () => {
    expect(serializeMembershipForm(base)).not.toBe(serializeMembershipForm({ ...base, emName: "Sam" }));
  });

  it("a nested address change → different key (where flat compare would miss it)", () => {
    const next = { ...base, address: { ...base.address, city: "Dallas" } };
    expect(serializeMembershipForm(base)).not.toBe(serializeMembershipForm(next));
  });

  it("a nested child change → different key", () => {
    const next = { ...base, children: [{ ...base.children[0], allergies: "none" }] };
    expect(serializeMembershipForm(base)).not.toBe(serializeMembershipForm(next));
  });

  it("editing the freeform notes → different key (dirty)", () => {
    expect(serializeMembershipForm(base)).not.toBe(serializeMembershipForm({ ...base, notes: "volunteer only" }));
  });
});
