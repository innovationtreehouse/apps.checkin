import { mapServerFields, validateIntake } from "@/app/membership/membershipForm";

const filled = {
  address: { line1: "1 A St", line2: "", city: "Austin", state: "TX", postalCode: "78701" },
  emName: "Jo", emPhone: "512-555-1234", emEmail: "",
  primary: { name: "Pat", email: "", dob: "", over25: true, allergies: "" },
  hasSecondary: false,
  secondary: { id: undefined, name: "", email: "", dob: "", over25: false, allergies: "" },
  children: [] as { id?: number; name: string; email: string; dob: string; over25: boolean; allergies: string }[],
};
const member = (dob: string, over25: boolean) => ({ id: 4, name: "Sam", email: "", dob, over25, allergies: "" });

describe("validateIntake — ages", () => {
  it("asks the primary parent for a date of birth or over 25", () => {
    expect(validateIntake({ ...filled, primary: { ...filled.primary, over25: false } }).primaryAge).toBeDefined();
    expect(validateIntake(filled).primaryAge).toBeUndefined();
  });

  it("asks for a date of birth for a child with none", () => {
    expect(validateIntake({ ...filled, children: [member("", false)] }).childAges).toBeDefined();
  });

  it("accepts a non-lead adult on file as over 25 with no date of birth", () => {
    expect(validateIntake({ ...filled, children: [member("", true)] }).childAges).toBeUndefined();
  });
});

describe("mapServerFields", () => {
  it("flags the household ages when the server reports memberAges", () => {
    expect(mapServerFields(["memberAges"]).childAges).toBeDefined();
  });
});
