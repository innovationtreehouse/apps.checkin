import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueueCount } from "@checkin/receipt/pages/financeQueue";

describe("QueueCount", () => {
  it("caps the pill at 99+ and keeps the exact count in its accessible name", () => {
    render(
      <MantineProvider>
        <QueueCount badge={{ count: 250, intent: "action" }} />
      </MantineProvider>,
    );
    expect(screen.getByLabelText("250 to act on")).toHaveTextContent(/^99\+$/);
  });
});
