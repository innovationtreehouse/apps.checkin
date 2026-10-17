// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { ToolManagementPanel } from "../ToolManagementPanel";

// Note: GrantForm's member/tool Select mounts its option list in the DOM even
// closed, so a name that's also a Select option (e.g. "Alice" as a member
// option) matches twice. Where that collides, assertions below scope to the
// Mantine <Text> ("p") that renders the roster row, not the Select's <span>.
//
// GrantForm's certify flow uses a real Mantine Select/Combobox (searchable for
// Member, plain for Level): clicking the input opens the option list, then the
// option itself must be clicked by its `[role="option"] span` — a plain
// fireEvent.change on the input does not select anything. jsdom also lacks
// scrollIntoView, which Mantine's combobox keyboard-nav effect calls on open.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const TABLE_SAW = { id: 1, name: "Table Saw", safetyGuide: null, _count: { toolStatuses: 2 } };
const LASER = { id: 2, name: "Laser Cutter", safetyGuide: "https://example.com/guide", _count: { toolStatuses: 0 } };
const MEMBERS = [
  { id: 10, name: "Alice", email: "alice@example.com" },
  { id: 11, name: "Bob", email: "bob@example.com" },
];

/** Open a Select's dropdown and click the option with the given label. */
function pickOption(input: HTMLElement, label: string) {
  fireEvent.click(input);
  fireEvent.click(screen.getByText(label, { selector: '[role="option"] span' }));
}

beforeEach(() => resetRtl());

describe("ToolManagementPanel", () => {
  it("loads and renders the tool list", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/tools": [TABLE_SAW, LASER],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    expect(await screen.findByText("Table Saw")).toBeInTheDocument();
    expect(screen.getByText("Laser Cutter")).toBeInTheDocument();
    expect(screen.getByText("2 certified")).toBeInTheDocument();
  });

  it("expanding a tool fetches and shows its certified-members roster", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?toolId=1": [
        { personId: 10, toolId: 1, level: "CERTIFIED", person: { id: 10, name: "Alice" } },
      ],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));

    expect(await screen.findByText("Alice", { selector: "p" })).toBeInTheDocument();
  });

  it("edits a tool's safety guide URL (PATCH) and shows the success message", async () => {
    // Single tool in the list: ToolsTab's certs Collapse content stays mounted
    // (just visually hidden) for every card, so a second tool here would make
    // "Edit guide" ambiguous.
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/shop/tools/1": { success: true, tool: { ...TABLE_SAW, safetyGuide: "https://new.example.com" } },
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit guide" }));
    // Modal mounts a tick after the click (Mantine portal), not synchronously.
    fireEvent.change(await screen.findByPlaceholderText("https://..."), { target: { value: "https://new.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/shop/tools/1", expect.objectContaining({ method: "PATCH" }));
    });
    expect(await screen.findByText("Safety guide updated.")).toBeInTheDocument();
  });

  it("By Person tab: lists members and loads a member's certifications on expand", async () => {
    // Single member: same shared-Collapse-content reasoning as the tool list above.
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?personId=10": [
        { personId: 10, toolId: 1, level: "CERTIFIED", tool: { id: 1, name: "Table Saw" } },
      ],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: [MEMBERS[0]] },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("tab", { name: "By Person" }));
    fireEvent.click(await screen.findByText("Alice"));

    expect(await screen.findByText("Table Saw", { selector: "p" })).toBeInTheDocument();
  });

  it("All Assignments tab: renders the person x tool matrix from ?all=true", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?all=true": [
        {
          personId: 10,
          toolId: 1,
          level: "CERTIFIED",
          person: { id: 10, name: "Alice" },
          tool: { id: 1, name: "Table Saw" },
        },
      ],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("tab", { name: "All Assignments" }));

    expect(await screen.findByText("1 assignment")).toBeInTheDocument();
  });

  it("shows a Forbidden alert for a user with none of the required roles", async () => {
    setSession({ id: 1 });
    mockFetchJson({
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    expect(await screen.findByText(/Forbidden/)).toBeInTheDocument();
  });

  it("non-admin certifier: hides Edit guide, excludes the Certifier level option, and grants a certification", async () => {
    // Certifier via toolStatuses, not sysadmin/board — canGrantCertifier should be false.
    setSession({ id: 1, isSysadmin: false, isBoardMember: false, toolStatuses: [{ level: "MAY_CERTIFY_OTHERS" }] });
    const fetchMock = mockFetchJson({
      "/api/shop/certifications?toolId=1": [],
      "/api/shop/certifications": { success: true },
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));
    const memberInput = await screen.findByPlaceholderText("-- Member --");
    expect(screen.queryByRole("button", { name: "Edit guide" })).not.toBeInTheDocument();

    const levelInput = screen.getByDisplayValue("Certified");
    fireEvent.click(levelInput);
    expect(screen.queryByText("Certifier", { selector: '[role="option"] span' })).not.toBeInTheDocument();

    pickOption(memberInput, "Alice");
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    expect(await screen.findByText("Confirm Certification")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/shop/certifications", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText(/Certification updated for Alice on Table Saw/)).toBeInTheDocument();
  });

  it("GrantForm: Cancel in the confirm modal closes it without submitting", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/shop/certifications?toolId=1": [],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));
    const memberInput = await screen.findByPlaceholderText("-- Member --");
    pickOption(memberInput, "Alice");
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    expect(await screen.findByText("Confirm Certification")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Confirm Certification")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/shop/certifications", expect.objectContaining({ method: "POST" }));
  });

  it("GrantForm: submitting without a member selected does not open the confirm modal", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?toolId=1": [],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));
    await screen.findByPlaceholderText("-- Member --");
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));

    expect(screen.queryByText("Confirm Certification")).not.toBeInTheDocument();
  });

  it("GrantForm: shows the server's error message on a failed grant", async () => {
    setSession({ id: 1, isSysadmin: true });
    // mockFetchJson always answers a matched route with ok:true, so a real
    // ok:false response needs a method-aware stub (GET the roster, POST fails).
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") {
        return { ok: false, status: 400, json: async () => ({ error: "Level exceeds your authorization." }) } as Response;
      }
      if (url.includes("/api/shop/certifications?toolId=1")) return { ok: true, json: async () => [] } as Response;
      if (url.includes("/api/shop/tools")) return { ok: true, json: async () => [TABLE_SAW] } as Response;
      if (url.includes("/api/shop/org-members")) return { ok: true, json: async () => ({ orgMembers: MEMBERS }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));
    const memberInput = await screen.findByPlaceholderText("-- Member --");
    pickOption(memberInput, "Alice");
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Level exceeds your authorization.")).toBeInTheDocument();
  });

  it("ToolsTab: collapses an expanded tool on second click", async () => {
    // Single tool: a second card's Collapse content stays mounted (just hidden),
    // so a second tool here would make the "Alice" roster row ambiguous.
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?toolId=1": [
        { personId: 10, toolId: 1, level: "CERTIFIED", person: { id: 10, name: "Alice" } },
      ],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));
    expect(await screen.findByText("Alice", { selector: "p" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Table Saw"));
    await waitFor(() => expect(screen.queryByText("Alice", { selector: "p" })).not.toBeInTheDocument());
  });

  it("ToolsTab: search filters the tool list to 'No tools match'", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/tools": [TABLE_SAW, LASER],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    await screen.findByText("Table Saw");
    fireEvent.change(screen.getByPlaceholderText("Search tools..."), { target: { value: "nonexistent" } });
    expect(await screen.findByText("No tools match.")).toBeInTheDocument();
  });

  it("ToolsTab: a failed safety-guide save shows the failure message", async () => {
    // mockFetchJson can't produce ok:false for a matched route (and "/api/shop/tools"
    // would otherwise substring-match the PATCH to .../tools/1), so a method-aware
    // stub is needed to fail just the PATCH.
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "PATCH") return { ok: false, status: 500, json: async () => ({}) } as Response;
      if (url.includes("/api/shop/tools")) return { ok: true, json: async () => [TABLE_SAW] } as Response;
      if (url.includes("/api/shop/org-members")) return { ok: true, json: async () => ({ orgMembers: MEMBERS }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit guide" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText("Failed to update.")).toBeInTheDocument();
  });

  it("ToolsTab: saving the guide while the tool is expanded refetches its certifications", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/shop/certifications?toolId=1": [],
      "/api/shop/tools/1": { success: true, tool: { ...TABLE_SAW, safetyGuide: "https://new.example.com" } },
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByText("Table Saw"));
    await screen.findByText("No certifications yet.");

    fireEvent.click(screen.getByRole("button", { name: "Edit guide" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText("Safety guide updated.")).toBeInTheDocument();
    const certCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/shop/certifications?toolId=1"));
    expect(certCalls.length).toBe(2);
  });

  it("PersonTab: collapses an expanded member on second click, and filters to 'No members match'", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?personId=10": [
        { personId: 10, toolId: 1, level: "CERTIFIED", tool: { id: 1, name: "Table Saw" } },
      ],
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: [MEMBERS[0]] },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("tab", { name: "By Person" }));
    fireEvent.click(await screen.findByText("Alice"));
    expect(await screen.findByText("Table Saw", { selector: "p" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Alice"));
    await waitFor(() => expect(screen.queryByText("Table Saw", { selector: "p" })).not.toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Search members by name, email, or ID..."), { target: { value: "nonexistent" } });
    expect(await screen.findByText("No members match.")).toBeInTheDocument();
  });

  it("PersonTab: grant flow uses the Tool select (prefillMemberId variant)", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/shop/certifications?personId=10": [],
      "/api/shop/certifications": { success: true },
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: [MEMBERS[0]] },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("tab", { name: "By Person" }));
    fireEvent.click(await screen.findByText("Alice"));
    const toolInput = await screen.findByPlaceholderText("-- Tool --");
    pickOption(toolInput, "Table Saw");

    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/shop/certifications", expect.objectContaining({ method: "POST" })),
    );
  });

  it("AllTab: shows an empty state when the certifications fetch fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/tools": [TABLE_SAW],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("tab", { name: "All Assignments" }));

    expect(await screen.findByText("No assignments found.")).toBeInTheDocument();
  });

  it("AllTab: search narrows the matrix by tool or member name", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({
      "/api/shop/certifications?all=true": [
        {
          personId: 10, toolId: 1, level: "CERTIFIED",
          person: { id: 10, name: "Alice" }, tool: { id: 1, name: "Table Saw" },
        },
      ],
      "/api/shop/tools": [TABLE_SAW, LASER],
      "/api/shop/org-members": { orgMembers: MEMBERS },
    });
    renderWithProviders(<ToolManagementPanel />);

    fireEvent.click(await screen.findByRole("tab", { name: "All Assignments" }));
    await screen.findByText("1 assignment");

    // Matches a tool name: narrows columns to just that tool.
    fireEvent.change(screen.getByPlaceholderText("Filter by tool or member..."), { target: { value: "Table Saw" } });
    expect(screen.getByText("Table Saw")).toBeInTheDocument();
    expect(screen.queryByText("Laser Cutter")).not.toBeInTheDocument();

    // Matches nothing on either axis: falls back to showing everything.
    fireEvent.change(screen.getByPlaceholderText("Filter by tool or member..."), { target: { value: "zzz" } });
    expect(screen.getByText("Table Saw")).toBeInTheDocument();
    expect(screen.getByText("Laser Cutter")).toBeInTheDocument();
  });
});
