import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { useSeedForm } from "../useSeedForm";

interface Answer {
  name: string;
}

/** The shape every seeded page has: a field, a snapshot of it, and dirty as their difference. */
function useForm(data: Answer | null) {
  const [name, setName] = useState("");
  const [initial, setInitial] = useState<string | null>(null);
  const dirty = initial !== null && initial !== name;
  useSeedForm(data, dirty, (answer) => {
    setName(answer.name);
    setInitial(answer.name);
  });
  return { name, setName, dirty, markSaved: () => setInitial(name) };
}

const renderForm = (first: Answer | null) =>
  renderHook(({ data }) => useForm(data), { initialProps: { data: first } });

describe("useSeedForm", () => {
  it("seeds from the first answer", () => {
    const { result } = renderForm({ name: "first" });
    expect(result.current.name).toBe("first");
    expect(result.current.dirty).toBe(false);
  });

  it("keeps an unsaved edit when the answer changes", () => {
    const { result, rerender } = renderForm({ name: "first" });
    act(() => result.current.setName("typing"));

    rerender({ data: { name: "second" } });

    expect(result.current.name).toBe("typing");
  });

  it("takes a changed answer on a form with no edits", () => {
    const { result, rerender } = renderForm({ name: "first" });

    rerender({ data: { name: "second" } });

    expect(result.current.name).toBe("second");
  });

  it("reseeds from the reload answer after a save", () => {
    const { result, rerender } = renderForm({ name: "first" });
    act(() => result.current.setName("  saved  "));
    act(() => result.current.markSaved());

    rerender({ data: { name: "saved" } });

    expect(result.current.name).toBe("saved");
    expect(result.current.dirty).toBe(false);
  });

  it("does not reseed when the same answer comes back", () => {
    const answer = { name: "first" };
    const { result, rerender } = renderForm(answer);
    act(() => result.current.setName("typing"));
    act(() => result.current.markSaved());
    act(() => result.current.setName("first"));
    act(() => result.current.markSaved());
    act(() => result.current.setName("clean"));
    act(() => result.current.markSaved());

    rerender({ data: answer });

    expect(result.current.name).toBe("clean");
  });
});
