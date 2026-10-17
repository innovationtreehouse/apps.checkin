import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import BgAttestationsPage from "../page";

beforeEach(() => resetRtl());

const household = (id: number, name: string) => ({ id, name });

const rows = [
  {
    id: 1, result: "APPROVE", createdAt: "2026-09-02T00:00:00.000Z",
    reviewer: { id: 10, name: "Rita Reviewer" },
    subjectPerson: { id: 20, name: "Ana Alvarez" },
    process: {
      id: 100, kind: "INITIAL", status: "ACTIVE", bgClearedAt: "2026-09-02T00:00:00.000Z",
      subjectPerson: null, orgMembership: { household: household(1, "Alvarez") },
    },
  },
  {
    id: 2, result: "REJECT", createdAt: "2026-09-01T00:00:00.000Z",
    reviewer: { id: 11, name: "Bob Board" },
    subjectPerson: null,
    process: {
      id: 101, kind: "PERSON_BG", status: "BLOCKED", bgClearedAt: null,
      subjectPerson: { id: 21, name: "Zed Zimmer", householdId: 2, household: household(2, "Zimmer") },
      orgMembership: null,
    },
  },
];

const bodyRowText = () =>
  screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");

describe("membership-audit/bg-attestations page", () => {
  it("filters by search text and by chip", async () => {
    mockFetchJson({ "/api/membership-audit/bg-attestations": rows });
    renderWithProviders(<BgAttestationsPage />);

    expect(await screen.findByText("Ana Alvarez")).toBeInTheDocument();
    expect(bodyRowText()).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Search attestations"), { target: { value: "zimm" } });
    expect(bodyRowText()).toHaveLength(1);
    expect(bodyRowText()[0]).toContain("Zed Zimmer");

    fireEvent.change(screen.getByLabelText("Search attestations"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Cleared" }));
    expect(bodyRowText()).toHaveLength(1);
    expect(bodyRowText()[0]).toContain("Ana Alvarez");
  });

  it("sorts by a column header", async () => {
    mockFetchJson({ "/api/membership-audit/bg-attestations": rows });
    renderWithProviders(<BgAttestationsPage />);
    await screen.findByText("Ana Alvarez");

    fireEvent.click(screen.getByRole("button", { name: /Reviewer/ }));
    expect(bodyRowText()[0]).toContain("Bob Board");
  });
});
