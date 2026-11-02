import { act } from "@testing-library/react";

/** Lets stubbed requests answer and the page render, so an absence check runs after a load has settled. */
export const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
