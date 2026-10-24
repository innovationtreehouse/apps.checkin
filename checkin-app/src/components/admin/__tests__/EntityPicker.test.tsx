import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { EntityPicker } from "../EntityPicker";

// Mantine's MantineProvider touches matchMedia, which jsdom doesn't implement.
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
});

type Opt = { id: number; name: string };

function renderPicker(props: Partial<React.ComponentProps<typeof EntityPicker<Opt>>> = {}) {
  const defaults = {
    search: jest.fn().mockResolvedValue([] as Opt[]),
    onSelect: jest.fn(),
    onClear: jest.fn(),
    selectedId: null,
    getOptionLabel: (o: Opt) => o.name,
    placeholder: "Search...",
    debounceMs: 0,
  };
  const merged = { ...defaults, ...props };
  render(
    <MantineProvider>
      <EntityPicker<Opt> {...merged} />
    </MantineProvider>,
  );
  return merged;
}

describe("EntityPicker", () => {
  it("searches on input and selects a clicked option", async () => {
    const search = jest.fn().mockResolvedValue([{ id: 5, name: "Acme" }]);
    const onSelect = jest.fn();
    renderPicker({ search, onSelect });

    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "ac" } });
    fireEvent.click(await screen.findByText("Acme"));

    expect(search).toHaveBeenCalledWith("ac");
    expect(onSelect).toHaveBeenCalledWith({ id: 5, name: "Acme" });
  });

  it("shows the selected label with a Clear button and does not search while selected", () => {
    const search = jest.fn();
    const onClear = jest.fn();
    renderPicker({ search, onClear, selectedId: 5, selectedLabel: "Acme Household" });

    expect(screen.getByDisplayValue("Acme Household")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear"));

    expect(onClear).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("does not search below minChars", async () => {
    const search = jest.fn().mockResolvedValue([]);
    renderPicker({ search, minChars: 3 });

    fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value: "ab" } });
    // give the (zero-delay) debounce a chance to fire
    await new Promise((r) => setTimeout(r, 10));

    expect(search).not.toHaveBeenCalled();
  });

  it("clears the results once the query drops below minChars", async () => {
    const search = jest.fn().mockResolvedValue([{ id: 5, name: "Acme" }]);
    renderPicker({ search, minChars: 2 });
    const input = screen.getByPlaceholderText("Search...");

    fireEvent.change(input, { target: { value: "ac" } });
    expect(await screen.findByText("Acme")).toBeTruthy();

    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.queryByText("Acme")).toBeNull();
  });
});
