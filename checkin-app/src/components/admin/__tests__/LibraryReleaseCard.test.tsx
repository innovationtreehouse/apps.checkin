import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { LibraryReleaseCard } from "../LibraryReleaseCard";

beforeEach(() => resetRtl());

describe("LibraryReleaseCard", () => {
  it("sends only the toggled library and shows the server's merged list", async () => {
    const fetchMock = mockFetchJson({
      "/api/settings/membership": { settings: { releasedLibraries: ["catalog", "expense", "income"] } },
    });
    renderWithProviders(<LibraryReleaseCard initial={["catalog"]} />);

    fireEvent.click(screen.getByLabelText(/^Expense/));

    await waitFor(() => expect(screen.getByLabelText(/^Income/)).toBeChecked());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      releaseLibrary: { library: "expense", released: true },
    });
    expect(screen.getByLabelText(/^Expense/)).toBeChecked();
  });
});
