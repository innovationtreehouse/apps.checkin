// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));

import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { invalidateLoads } from "@checkin/component-ui";
import { renderWithProviders, mockFetchJson, setSession, resetRtl, router } from "@/test-helpers/rtl";
import { REGISTRY } from "@/lib/email-templates/registry";
import EmailSettingsPage from "../page";

beforeEach(() => resetRtl());

describe("EmailSettingsPage", () => {
  it("first-time set: fields editable, no unlock checkbox, saves the entered identity", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const from = await screen.findByLabelText(/From address/i);
    expect(from).not.toBeDisabled();
    expect(screen.queryByText(/let me edit the sender addresses/i)).not.toBeInTheDocument();

    fireEvent.change(from, { target: { value: "Org <no-reply@org.test>" } });
    fireEvent.change(screen.getByLabelText(/Reply-To address/i), { target: { value: "board@org.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual({
      emailFromAddress: "Org <no-reply@org.test>",
      emailReplyToAddress: "board@org.test",
      scholarshipNotifyEmail: null,
      financeAlertEmailAddress: null,
      boardEmailAddress: null,
      sysadminEmailAddress: null,
      bgReviewerEmailAddress: null,
      financeContactEmail: null,
      scholarshipAckSubject: null,
      scholarshipAckMembershipBody: null,
      scholarshipAckProgramBody: null,
    });
  });

  it("already set: From and Reply-To locked until the confirm checkbox unlocks them; other fields stay editable", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: "Org <no-reply@org.test>", emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const from = await screen.findByLabelText(/From address/i);
    const replyTo = screen.getByLabelText(/Reply-To address/i);
    expect(from).toBeDisabled();
    expect(replyTo).toBeDisabled();
    expect(screen.getByLabelText(/Finance alert address/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/Scholarship ACK subject/i)).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Save settings" })).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText(/let me edit the sender addresses/i));
    expect(from).not.toBeDisabled();
    expect(replyTo).not.toBeDisabled();
  });

  it("already set: saves a finance alert address without unlocking, sending no sender fields", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: "Org <no-reply@org.test>", emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    await screen.findByLabelText(/From address/i);
    fireEvent.change(screen.getByLabelText(/Finance alert address/i), { target: { value: "alerts@org.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    const body = JSON.parse(putOpts!.body as string);
    expect(body).toMatchObject({ financeAlertEmailAddress: "alerts@org.test" });
    expect(body).not.toHaveProperty("emailFromAddress");
    expect(body).not.toHaveProperty("emailReplyToAddress");
  });

  it("already set: a From edited then re-locked is not sent, and the field shows the saved From again", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: "Org <no-reply@org.test>", emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const from = await screen.findByLabelText(/From address/i);
    const unlock = screen.getByLabelText(/let me edit the sender addresses/i);
    fireEvent.click(unlock);
    fireEvent.change(from, { target: { value: "half-edited" } });
    fireEvent.click(unlock);
    fireEvent.change(screen.getByLabelText(/Finance alert address/i), { target: { value: "alerts@org.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    const body = JSON.parse(putOpts!.body as string);
    expect(body).toMatchObject({ financeAlertEmailAddress: "alerts@org.test" });
    expect(body).not.toHaveProperty("emailFromAddress");
    expect(body).not.toHaveProperty("emailReplyToAddress");
    await waitFor(() => expect(from).toHaveValue("Org <no-reply@org.test>"));
  });

  it("accepts a comma-separated Reply-To list: no inline error, PUT fires", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    await screen.findByLabelText(/From address/i);
    fireEvent.change(screen.getByLabelText(/Reply-To address/i), { target: { value: "info@org.test, ops@org.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    expect(screen.queryByText(/Enter one or more comma-separated addresses/i)).not.toBeInTheDocument();
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual({
      emailFromAddress: null,
      emailReplyToAddress: "info@org.test, ops@org.test",
      scholarshipNotifyEmail: null,
      financeAlertEmailAddress: null,
      boardEmailAddress: null,
      sysadminEmailAddress: null,
      bgReviewerEmailAddress: null,
      financeContactEmail: null,
      scholarshipAckSubject: null,
      scholarshipAckMembershipBody: null,
      scholarshipAckProgramBody: null,
    });
  });

  it("validates client-side: a malformed From shows an inline error and never PUTs", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const from = await screen.findByLabelText(/From address/i);
    fireEvent.change(from, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText(/Enter an email address/i)).toBeInTheDocument();
    // Only the initial GET happened — no PUT was attempted.
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);
  });

  it("Scholarship review notifications: renders, loads its value, and trims into the PUT body", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null, scholarshipNotifyEmail: "finance@org.test" } },
    });
    renderWithProviders(<EmailSettingsPage />);

    const notify = await screen.findByLabelText(/Scholarship review notifications/i);
    expect(notify).toHaveValue("finance@org.test");

    fireEvent.change(notify, { target: { value: " board@org.test, ops@org.test  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual({
      emailFromAddress: null,
      emailReplyToAddress: null,
      scholarshipNotifyEmail: "board@org.test, ops@org.test",
      financeAlertEmailAddress: null,
      boardEmailAddress: null,
      sysadminEmailAddress: null,
      bgReviewerEmailAddress: null,
      financeContactEmail: null,
      scholarshipAckSubject: null,
      scholarshipAckMembershipBody: null,
      scholarshipAckProgramBody: null,
    });
  });

  it("Scholarship ACK fields: render with default-copy placeholders, load configured values, and trim into the PUT body", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({
      "/api/settings/email": {
        settings: {
          emailFromAddress: null, emailReplyToAddress: null,
          scholarshipAckSubject: "Custom subject", scholarshipAckMembershipBody: null, scholarshipAckProgramBody: null,
        },
      },
    });
    renderWithProviders(<EmailSettingsPage />);

    const subject = await screen.findByLabelText(/Scholarship ACK subject/i);
    expect(subject).toHaveValue("Custom subject");
    const membershipBody = screen.getByLabelText(/Scholarship ACK body — membership fee request/i);
    expect(membershipBody).toHaveValue("");
    expect(membershipBody).toHaveAttribute("placeholder", REGISTRY["scholarship.ackMembership"].defaultBody);
    const programBody = screen.getByLabelText(/Scholarship ACK body — program request/i);
    expect(programBody).toHaveAttribute("placeholder", REGISTRY["scholarship.ackProgram"].defaultBody);

    fireEvent.change(programBody, { target: { value: "  Thanks for applying to {{programName}}!  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toEqual({
      emailFromAddress: null,
      emailReplyToAddress: null,
      scholarshipNotifyEmail: null,
      financeAlertEmailAddress: null,
      boardEmailAddress: null,
      sysadminEmailAddress: null,
      bgReviewerEmailAddress: null,
      financeContactEmail: null,
      scholarshipAckSubject: "Custom subject",
      scholarshipAckMembershipBody: null,
      scholarshipAckProgramBody: "Thanks for applying to {{programName}}!",
    });
  });

  it("Scholarship review notifications: a malformed value shows an inline error and blocks save", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null, scholarshipNotifyEmail: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const notify = await screen.findByLabelText(/Scholarship review notifications/i);
    fireEvent.change(notify, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText(/Enter one or more comma-separated addresses/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);
  });

  it("Finance alert address: saves one address, and a malformed one shows an inline error and blocks save", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null, financeAlertEmailAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const alert = await screen.findByLabelText(/^Finance alert address/i);
    fireEvent.change(alert, { target: { value: "a@org.test, b@org.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Enter one email address.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);

    fireEvent.change(alert, { target: { value: " finance@org.test " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toMatchObject({ financeAlertEmailAddress: "finance@org.test", boardEmailAddress: null });
  });

  it("shows a Not set pill beside each empty address, and none beside a saved one", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null, financeAlertEmailAddress: "alerts@org.test", boardEmailAddress: null, financeContactEmail: null } } });
    renderWithProviders(<EmailSettingsPage />);

    expect(await screen.findByLabelText(/^Board address/i)).toBeInTheDocument();
    expect(screen.getAllByText("Not set")).toHaveLength(4);
    const labelOf = (name: RegExp) => document.querySelector(`label[for="${screen.getByLabelText(name).id}"]`);
    expect(labelOf(/^Board address/i)).toHaveTextContent("Not set");
    expect(labelOf(/^Sysadmin list/i)).toHaveTextContent("Not set");
    expect(labelOf(/^Background-check reviewer list/i)).toHaveTextContent("Not set");
    expect(labelOf(/^Finance contact address/i)).toHaveTextContent("Not set");
    expect(labelOf(/^Finance alert address/i)).not.toHaveTextContent("Not set");
  });

  it("Finance contact address: a malformed value blocks save, a valid one is sent", async () => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const contact = await screen.findByLabelText(/^Finance contact address/i);
    fireEvent.change(contact, { target: { value: "finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Enter one email address.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);

    fireEvent.change(contact, { target: { value: "finance@org.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toMatchObject({ financeContactEmail: "finance@org.test" });
  });

  it("redirects a user without board/sysadmin and never renders the form", async () => {
    setSession({ id: 9 }); // authenticated but no roles
    mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
    expect(screen.queryByLabelText(/From address/i)).not.toBeInTheDocument();
  });

  describe("a refetch", () => {
    const answer = (emailFromAddress: string) => ({ settings: { emailFromAddress, emailReplyToAddress: null } });
    const refetch = async (fetchMock: jest.Mock) => {
      const reads = fetchMock.mock.calls.length;
      act(() => { void invalidateLoads(); });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(reads));
    };

    it("keeps unsaved input when the answer changes", async () => {
      setSession({ id: 1, isSysadmin: true });
      let current = answer("first@example.com");
      const fetchMock = mockFetchJson({ "/api/settings/email": () => current });
      renderWithProviders(<EmailSettingsPage />);
      await screen.findByDisplayValue("first@example.com");
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.change(screen.getByLabelText("From address"), { target: { value: "typing@example.com" } });

      current = answer("second@example.com");
      await refetch(fetchMock);

      await act(async () => {});
      expect(screen.getByLabelText("From address")).toHaveValue("typing@example.com");
    });

    it("updates a clean form with the new answer", async () => {
      setSession({ id: 1, isSysadmin: true });
      let current = answer("first@example.com");
      const fetchMock = mockFetchJson({ "/api/settings/email": () => current });
      renderWithProviders(<EmailSettingsPage />);
      await screen.findByDisplayValue("first@example.com");

      current = answer("second@example.com");
      await refetch(fetchMock);

      expect(await screen.findByDisplayValue("second@example.com")).toBeInTheDocument();
    });
  });

  it.each([
    [/^Sysadmin list/i, "sysadminEmailAddress"],
    [/^Background-check reviewer list/i, "bgReviewerEmailAddress"],
  ])("%s: a malformed value blocks save, a valid one is sent as %s", async (label, field) => {
    setSession({ id: 1, isSysadmin: true });
    const fetchMock = mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    const input = await screen.findByLabelText(label);
    fireEvent.change(input, { target: { value: "List <list@org.test>" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Enter one email address.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);

    fireEvent.change(input, { target: { value: " list@org.test " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/email", expect.objectContaining({ method: "PUT" })));
    const [, putOpts] = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT")!;
    expect(JSON.parse(putOpts!.body as string)).toMatchObject({ [field]: "list@org.test" });
  });

  it("says each required address must be set, shows no separate alert address field, and leaves the scholarship list optional", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/settings/email": { settings: { emailFromAddress: null, emailReplyToAddress: null } } });
    renderWithProviders(<EmailSettingsPage />);

    await screen.findByLabelText(/^Finance alert address/i);
    for (const label of [/^Finance alert address/i, /^Board address/i, /^Sysadmin list/i, /^Background-check reviewer list/i, /^Finance contact address/i]) {
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(/Must be set\./);
    }
    expect(screen.getByLabelText(/Scholarship review notifications/i)).not.toHaveAccessibleDescription(/Must be set/);
    expect(screen.queryByLabelText(/^Alert address/i)).not.toBeInTheDocument();
  });
});
