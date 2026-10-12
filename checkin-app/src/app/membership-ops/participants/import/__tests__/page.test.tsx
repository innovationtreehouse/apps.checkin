// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import BulkImportParticipants from "../ImportParticipantsClient";

beforeEach(() => resetRtl());

const preview = {
  columns: ["firstName", "lastName", "email"],
  rows: [
    {
      rowNumber: 1,
      data: { firstName: "Jane", lastName: "Doe", email: "jane@example.com", parentEmail: "", dob: "1990-01-01", address: "", sameHouseholdAs: "" },
      status: "ready",
      action: "Create new participant",
      warnings: [],
    },
  ],
  summary: { ready: 1, update: 0, warning: 0, error: 0 },
};

function selectFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["a,b,c"], "participants.csv", { type: "text/csv" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("membership-ops/participants/import page", () => {
  it("renders the upload step", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<BulkImportParticipants />);

    expect(await screen.findByText("Bulk Import Participants")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview Import/ })).toBeDisabled();
  });

  it("previews a file and shows the parsed rows", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/membership-ops/participants/import/preview": preview });
    const { container } = renderWithProviders(<BulkImportParticipants />);
    await screen.findByText("Bulk Import Participants");

    selectFile(container);
    fireEvent.click(await screen.findByRole("button", { name: /Preview Import/ }));

    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import 1 Participant/ })).toBeInTheDocument();
  });

  it("confirms the import and shows the result", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/membership-ops/participants/import/preview": preview,
      "/api/membership-ops/participants/import": { message: "Imported 1 participant." },
    });
    const { container } = renderWithProviders(<BulkImportParticipants />);
    await screen.findByText("Bulk Import Participants");

    selectFile(container);
    fireEvent.click(await screen.findByRole("button", { name: /Preview Import/ }));
    await screen.findByText("Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: /Import 1 Participant/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/membership-ops/participants/import", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Imported 1 participant.")).toBeInTheDocument();
  });

  it("renders nothing for a background-check reviewer who navigates directly", () => {
    setSession({ id: 9, isBackgroundCheckReviewer: true });
    mockFetchJson({});
    renderWithProviders(<BulkImportParticipants />);

    expect(screen.queryByRole("button", { name: /Preview Import/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Bulk Import Participants")).not.toBeInTheDocument();
  });
});
