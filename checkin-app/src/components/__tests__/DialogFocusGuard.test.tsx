import { render } from "@testing-library/react";
import DialogFocusGuard from "../DialogFocusGuard";

const flushObserver = () => new Promise((resolve) => setTimeout(resolve));

function page() {
  return render(
    <>
      <DialogFocusGuard />
      <button data-testid="behind">Behind</button>
      <section role="dialog" tabIndex={-1} data-testid="modal">
        <button data-testid="submit">Create</button>
        <button data-testid="other">Cancel</button>
        <section role="dialog" tabIndex={-1} data-testid="confirm">
          <button data-testid="confirm-submit">Confirm</button>
        </section>
      </section>
    </>,
  );
}

describe("DialogFocusGuard", () => {
  it("moves focus to the dialog when its focused button becomes disabled", async () => {
    const { getByTestId } = page();
    getByTestId("submit").focus();
    getByTestId("submit").setAttribute("disabled", "");
    await flushObserver();
    expect(document.activeElement).toBe(getByTestId("modal"));
  });

  it("picks the nearest dialog when one sits inside another", async () => {
    const { getByTestId } = page();
    getByTestId("confirm-submit").focus();
    getByTestId("confirm-submit").setAttribute("disabled", "");
    await flushObserver();
    expect(document.activeElement).toBe(getByTestId("confirm"));
  });

  it("leaves focus alone when a different element becomes disabled", async () => {
    const { getByTestId } = page();
    getByTestId("other").focus();
    getByTestId("submit").setAttribute("disabled", "");
    await flushObserver();
    expect(document.activeElement).toBe(getByTestId("other"));
  });

  it("leaves focus alone when the focused button is enabled again", async () => {
    const { getByTestId } = page();
    getByTestId("submit").focus();
    getByTestId("submit").setAttribute("disabled", "");
    getByTestId("submit").removeAttribute("disabled");
    await flushObserver();
    expect(document.activeElement).toBe(getByTestId("submit"));
  });

  it("leaves focus alone outside a dialog", async () => {
    const { getByTestId } = page();
    getByTestId("behind").focus();
    getByTestId("behind").setAttribute("disabled", "");
    await flushObserver();
    expect(document.activeElement).toBe(getByTestId("behind"));
  });
});
