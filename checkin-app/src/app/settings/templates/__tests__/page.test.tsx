jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { REGISTRY } from "@/lib/email-templates/registry";
import EmailTemplatesPage from "../page";

beforeEach(() => resetRtl());

const SAVED = { key: "enrollment.confirm", subject: "Welcome to {{programName}}", body: "Hi {{name}}.", updatedBy: 1, updatedAt: "2026-11-14T12:00:00.000Z" };
const { name, programName } = REGISTRY["enrollment.confirm"].sampleCtx;

async function open(key: string, templates: unknown[] = []) {
  setSession({ id: 1, isBoardMember: true });
  const fetchMock = mockFetchJson({ "/api/settings/templates": { templates } });
  renderWithProviders(<EmailTemplatesPage />);
  fireEvent.click(await screen.findByRole("textbox", { name: "Email" }));
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(`^${key.replace(".", "\\.")}`) }));
  return fetchMock;
}

const preview = () => screen.getByTitle(/: preview$/) as HTMLIFrameElement;

describe("EmailTemplatesPage", () => {
  it("lists every registry key grouped by prefix and marks the edited ones", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/templates": { templates: [SAVED] } });
    renderWithProviders(<EmailTemplatesPage />);
    fireEvent.click(await screen.findByRole("textbox", { name: "Email" }));
    expect(await screen.findAllByRole("option")).toHaveLength(Object.keys(REGISTRY).length);
    expect(screen.getByText("enrollment")).toBeInTheDocument();
    expect(screen.getByText("checkin")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "enrollment.confirm (edited)" })).toBeInTheDocument();
  });

  it("opens an unedited key on its default wording and previews it from the sample values", async () => {
    await open("enrollment.confirm");
    expect(screen.getByLabelText("Subject")).toHaveValue(REGISTRY["enrollment.confirm"].defaultSubject);
    expect(screen.getByText(`Confirmed: Enrollment in ${programName}`)).toBeInTheDocument();
    expect(preview().srcdoc).toContain(`Hi ${name}, you have been successfully enrolled in ${programName}.`);
    expect(screen.queryByRole("button", { name: "Use the default wording" })).not.toBeInTheDocument();
  });

  it("opens an edited key on the saved copy and updates the preview as the body changes", async () => {
    await open("enrollment.confirm", [SAVED]);
    expect(screen.getByLabelText("Subject")).toHaveValue(SAVED.subject);
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Line one\n\n<b>{{name}}</b>" } });
    expect(preview().srcdoc).toContain(`<p>Line one</p><p>&lt;b&gt;${name}&lt;/b&gt;</p>`);
  });

  it("saves the draft for the chosen key", async () => {
    const fetchMock = await open("enrollment.confirm");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "You're in {{programName}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/templates/enrollment.confirm", expect.objectContaining({ method: "PUT" })));
    const [, init] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(init!.body as string)).toEqual({ subject: "You're in {{programName}}", body: REGISTRY["enrollment.confirm"].defaultBody });
  });

  it("shows the default a blank field sends once the save lands", async () => {
    await open("enrollment.confirm");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue(REGISTRY["enrollment.confirm"].defaultSubject));
  });

  it("flags a token the key does not have on its field and blocks save and send", async () => {
    await open("enrollment.confirm");
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "See {{actionLink}}" } });
    expect(screen.getByText("This email has no {{actionLink}}.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save template" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send test to me" })).toBeDisabled();
  });

  it("sends the unsaved draft to the signed-in user", async () => {
    const fetchMock = await open("enrollment.confirm");
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Draft {{name}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Send test to me" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/templates/enrollment.confirm/test-send", expect.objectContaining({ method: "POST" })));
    const [, init] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "POST")!;
    expect(JSON.parse(init!.body as string)).toEqual({ subject: REGISTRY["enrollment.confirm"].defaultSubject, body: "Draft {{name}}" });
  });

  it("puts an edited key back on its default wording with a blank save", async () => {
    const fetchMock = await open("enrollment.confirm", [SAVED]);
    fireEvent.click(screen.getByRole("button", { name: "Use the default wording" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/templates/enrollment.confirm", expect.objectContaining({ method: "PUT" })));
    const [, init] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(init!.body as string)).toEqual({ subject: "", body: "" });
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue(REGISTRY["enrollment.confirm"].defaultSubject));
  });
});
