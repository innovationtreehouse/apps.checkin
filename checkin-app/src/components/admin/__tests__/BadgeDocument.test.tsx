import type { ReactNode } from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";
import BadgeDocument from "../BadgeDocument";

beforeEach(() => resetRtl());

// @react-pdf/renderer is pure ESM (untransformed by jest, see badgeNames.ts) and its
// primitives target a non-DOM reconciler, so swap them for plain DOM stand-ins to
// exercise BadgeDocument's own layout/branching logic via RTL.
jest.mock("@react-pdf/renderer", () => ({
  Document: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Page: ({ children }: { children?: ReactNode }) => <div data-testid="pdf-page">{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  // eslint-disable-next-line @next/next/no-img-element -- test stand-in, not app UI
  Image: ({ src }: { src?: string }) => <img alt="" src={src} />,
  StyleSheet: { create: (styles: unknown) => styles },
  Font: { register: jest.fn() },
}));

describe("BadgeDocument", () => {
  it("renders names without role pills, and chunks front/back pages of 8", () => {
    // Every fixture row carries both role flags, so a pill that came back would render.
    // displayName arrives pre-resolved from the page (#1625) — BadgeDocument prints it
    // verbatim and no longer derives anything from the batch it was handed.
    const badges = Array.from({ length: 9 }, (_, i) => ({
      id: i + 1,
      displayName: `Person ${i + 1}`,
      year: "2026-2027",
      isBoardMember: true,
      isKeyholder: true,
      qrDataUri: `data:image/png;base64,QR${i}`,
    }));

    renderWithProviders(<BadgeDocument badges={badges} />);

    expect(screen.getByText("Person 1")).toBeInTheDocument();
    expect(screen.getByText("Person 9")).toBeInTheDocument();
    expect(screen.queryByText("BOARD")).toBeNull();
    expect(screen.queryByText("KEYHOLDER")).toBeNull();
    expect(screen.getByText("ID: 1")).toBeInTheDocument();
    expect(screen.getByText("ID: 9")).toBeInTheDocument();

    // 9 badges -> 2 chunks of front+back = 4 pages.
    expect(screen.getAllByTestId("pdf-page")).toHaveLength(4);
  });

  // #1628. The year is per badge, so one print run mixes renewed and not-renewed
  // households. Rendering nothing rather than an empty <Text> keeps the header row to a
  // single child (the logo stays at flex-start either way under space-between), so no
  // stray element can pick up yearText's marginLeft or a future style.
  it("prints the year only on the badge that carries one", () => {
    const badges = [
      { id: 1, displayName: "Renewed Rita", year: "2026-2027", qrDataUri: "data:image/png;base64,QR1" },
      { id: 2, displayName: "Lapsed Larry", year: null, qrDataUri: "data:image/png;base64,QR2" },
    ];

    const { container } = renderWithProviders(<BadgeDocument badges={badges} />);

    expect(screen.getAllByText("2026-2027")).toHaveLength(1);
    // The front page's two badge Views: the renewed one has a year span beside the
    // logo, the other has nothing where it would have been.
    const headerSpans = [...container.querySelectorAll("img")]
      .filter(img => img.getAttribute("src")?.startsWith("/brand/"))
      .map(img => img.parentElement!.querySelectorAll("span").length);
    expect(headerSpans).toEqual([1, 0]);
  });
});
