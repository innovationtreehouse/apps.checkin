"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useViewer } from "@checkin/component-ui";
import { notifications } from "@mantine/notifications";
import {
  ActionIcon,
  Button,
  Checkbox,
  FileInput,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api, errorMessage, upload } from "../components/api";
import { CURRENCY_CODE } from "../lib/schemas";
import { listWords, missingDetails } from "../lib/missingDetails";

interface Line {
  description: string;
  quantity: number | "";
  unitPrice: number | "";
  partNumber: string;
  manufacturer: string;
  isDelayed: boolean;
}

interface Person {
  id: number;
  name: string;
}

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain";
const blankLine = (): Line => ({ description: "", quantity: 1, unitPrice: "", partNumber: "", manufacturer: "", isDelayed: false });

/** People whose name contains the typed text, from the reimbursee options route. */
function useReimburseeSearch(q: string): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api<Person[]>(`/reimbursee-options?q=${encodeURIComponent(term)}`)
        .then((rows) => { if (live) setPeople(rows); })
        .catch(() => { if (live) setPeople([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return people;
}

const SELF = "self";

/**
 * /receipts/upload — a photo, PDF or text file, with the details typed or read automatically.
 * Asking for a reimbursement is offered to adults only; the service enforces the same rule. The
 * uploader names who is reimbursed, themselves unless they pick someone else. Finance, operations
 * or the board may instead add someone who is not on file, as a non-member adult.
 */
export default function UploadPage() {
  const router = useRouter();
  const user = useViewer();
  const isAdult = user?.ageBand === "adult";
  const addsPeople = !!(user?.isFinance || user?.isOperations || user?.isBoardMember);

  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [retailer, setRetailer] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [total, setTotal] = useState<number | "">("");
  const [tax, setTax] = useState<number | "">("");
  const [shipping, setShipping] = useState<number | "">("");
  const [discount, setDiscount] = useState<number | "">("");
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [needsReimbursement, setNeedsReimbursement] = useState(false);
  const [reimbursee, setReimbursee] = useState<Person | null>(null);
  const [reimburseeSearch, setReimburseeSearch] = useState("");
  const found = useReimburseeSearch(reimburseeSearch);
  const [newPerson, setNewPerson] = useState<{ name: string; isAdult: boolean } | null>(null);
  const [isInKind, setIsInKind] = useState(false);
  const [selfDonor, setSelfDonor] = useState(true);
  const [donor, setDonor] = useState({ firstName: "", lastName: "", companyName: "" });
  const [busy, setBusy] = useState(false);

  const reimbursing = isAdult && !isInKind && needsReimbursement;
  const newPersonIncomplete = reimbursing && newPerson !== null && (!newPerson.name.trim() || !newPerson.isAdult);
  const currencyCode = currency.trim().toUpperCase() || "USD";
  const currencyError = mode === "manual" && !CURRENCY_CODE.test(currencyCode) ? "Use a 3-letter currency code, like USD" : null;

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    if (!file || currencyError) return;
    const missing = mode === "manual" ? missingDetails({ retailer, receiptDate, receiptTotalCents: total === "" ? null : total }) : [];
    if (missing.length > 0) {
      notifications.show({ title: "Receipt not uploaded", message: `Fill in the ${listWords(missing)}.`, color: "red", autoClose: false });
      return;
    }
    const data = {
      needsReimbursement: !isInKind && needsReimbursement,
      ...(reimbursing && newPerson ? { newReimbursee: { name: newPerson.name.trim(), isAdult: true } } : {}),
      ...(reimbursing && !newPerson && reimbursee ? { reimburseePersonId: reimbursee.id } : {}),
      isInKind,
      ...(isInKind ? { donor: selfDonor ? { self: true } : { ...donor, companyName: donor.companyName || null } } : {}),
      ...(mode === "manual"
        ? {
            details: {
              retailer,
              receiptDate,
              currency: currencyCode,
              receiptTotal: String(total || 0),
              tax: String(tax || 0),
              shipping: String(shipping || 0),
              discount: String(discount || 0),
              lineItems: lines.map((l) => ({
                description: l.description,
                partNumber: l.partNumber.trim() || null,
                manufacturer: l.manufacturer.trim() || null,
                quantity: l.quantity || 1,
                unitPrice: l.unitPrice || 0,
                isDelayed: l.isDelayed,
              })),
            },
          }
        : {}),
    };
    const form = new FormData();
    form.append("file", file);
    form.append("data", JSON.stringify(data));
    setBusy(true);
    try {
      const receipt = await upload<{ id: string }>(form);
      router.push(`/receipts/${receipt.id}`);
    } catch (err) {
      notifications.show({ title: "Upload failed", message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Title order={3} mb="md">Upload a receipt</Title>
      <Paper withBorder p="md" maw={640}>
        <Stack>
          <FileInput label="Receipt file" description="Photo, PDF or text, up to 10 MB" accept={ACCEPT} value={file} onChange={setFile} required />
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v === "manual" ? "manual" : "auto")}
            data={[{ value: "auto", label: "Read it for me" }, { value: "manual", label: "I'll type the details" }]}
          />
          {mode === "manual" && (
            <>
              <TextInput label="Retailer" value={retailer} onChange={(e) => setRetailer(e.currentTarget.value)} required />
              <Group grow>
                <TextInput label="Date" type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.currentTarget.value)} required />
                <TextInput label="Currency" description="3-letter code" maxLength={3} error={currencyError} value={currency} onChange={(e) => setCurrency(e.currentTarget.value)} />
              </Group>
              <Group grow>
                <NumberInput label="Total" prefix="$" decimalScale={2} min={0} value={total} onChange={(v) => setTotal(typeof v === "number" ? v : "")} required />
                <NumberInput label="Tax" prefix="$" decimalScale={2} min={0} value={tax} onChange={(v) => setTax(typeof v === "number" ? v : "")} />
                <NumberInput label="Shipping" prefix="$" decimalScale={2} min={0} value={shipping} onChange={(v) => setShipping(typeof v === "number" ? v : "")} />
                <NumberInput label="Discount" prefix="$" decimalScale={2} min={0} value={discount} onChange={(v) => setDiscount(typeof v === "number" ? v : "")} />
              </Group>
              <Text fw={500} size="sm">Items</Text>
              {lines.map((l, i) => (
                <Stack key={i} gap={6}>
                  <Group align="end" wrap="nowrap">
                    <TextInput label={i === 0 ? "Description" : undefined} aria-label={`Item ${i + 1} description`} style={{ flex: 1 }} value={l.description} onChange={(e) => setLine(i, { description: e.currentTarget.value })} />
                    <NumberInput label={i === 0 ? "Qty" : undefined} aria-label={`Item ${i + 1} quantity`} w={80} min={0} value={l.quantity} onChange={(v) => setLine(i, { quantity: typeof v === "number" ? v : "" })} />
                    <NumberInput label={i === 0 ? "Unit price" : undefined} aria-label={`Item ${i + 1} unit price`} w={120} prefix="$" decimalScale={2} min={0} value={l.unitPrice} onChange={(v) => setLine(i, { unitPrice: typeof v === "number" ? v : "" })} />
                    <ActionIcon variant="subtle" color="red" aria-label={`Remove item ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</ActionIcon>
                  </Group>
                  <Group align="center" wrap="nowrap">
                    <TextInput size="xs" placeholder="Part # (optional)" aria-label={`Item ${i + 1} part number`} maxLength={100} style={{ flex: 1 }} value={l.partNumber} onChange={(e) => setLine(i, { partNumber: e.currentTarget.value })} />
                    <TextInput size="xs" placeholder="Manufacturer (optional)" aria-label={`Item ${i + 1} manufacturer`} maxLength={100} style={{ flex: 1 }} value={l.manufacturer} onChange={(e) => setLine(i, { manufacturer: e.currentTarget.value })} />
                    <Checkbox size="xs" label="Backordered" aria-label={`Item ${i + 1} backordered`} checked={l.isDelayed} onChange={(e) => setLine(i, { isDelayed: e.currentTarget.checked })} />
                  </Group>
                </Stack>
              ))}
              <Button variant="light" size="xs" w="fit-content" onClick={() => setLines([...lines, blankLine()])}>Add item</Button>
            </>
          )}
          <Checkbox label="This is a donation" checked={isInKind} onChange={(e) => setIsInKind(e.currentTarget.checked)} />
          {isInKind && (
            <>
              <SegmentedControl
                value={selfDonor ? "self" : "other"}
                onChange={(v) => setSelfDonor(v === "self")}
                data={[{ value: "self", label: "I am the donor" }, { value: "other", label: "Someone else donated" }]}
              />
              {!selfDonor && (
                <Group grow>
                  <TextInput label="Donor first name" value={donor.firstName} onChange={(e) => setDonor({ ...donor, firstName: e.currentTarget.value })} required />
                  <TextInput label="Donor last name" value={donor.lastName} onChange={(e) => setDonor({ ...donor, lastName: e.currentTarget.value })} required />
                  <TextInput label="Company (optional)" value={donor.companyName} onChange={(e) => setDonor({ ...donor, companyName: e.currentTarget.value })} />
                </Group>
              )}
            </>
          )}
          {isAdult && !isInKind && (
            <Checkbox label="Someone needs to be reimbursed" checked={needsReimbursement} onChange={(e) => setNeedsReimbursement(e.currentTarget.checked)} />
          )}
          {reimbursing && !newPerson && (
            <Select
              label="Reimburse"
              description="Search by name if someone else paid"
              searchable
              searchValue={reimburseeSearch}
              onSearchChange={setReimburseeSearch}
              data={[
                { value: SELF, label: "Me" },
                ...[reimbursee, ...found]
                  .filter((p): p is Person => p !== null && p.id !== user?.id)
                  .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
                  .map((p) => ({ value: String(p.id), label: p.name })),
              ]}
              value={reimbursee ? String(reimbursee.id) : SELF}
              onChange={(v) => setReimbursee(v === null || v === SELF ? null : (found.find((p) => String(p.id) === v) ?? reimbursee))}
              filter={({ options }) => options}
              allowDeselect={false}
              nothingFoundMessage="No matching people"
            />
          )}
          {reimbursing && addsPeople && (
            <Checkbox
              label="Not a member / not in the list"
              checked={newPerson !== null}
              onChange={(e) => setNewPerson(e.currentTarget.checked ? { name: "", isAdult: false } : null)}
            />
          )}
          {reimbursing && addsPeople && newPerson && (
            <>
              <TextInput
                label="Their full name"
                description="Adds them as a non-member, who is reimbursed"
                maxLength={200}
                value={newPerson.name}
                onChange={(e) => setNewPerson({ ...newPerson, name: e.currentTarget.value })}
                required
              />
              <Checkbox label="They are an adult (18 or over)" checked={newPerson.isAdult} onChange={(e) => setNewPerson({ ...newPerson, isAdult: e.currentTarget.checked })} />
            </>
          )}
          <Button onClick={() => void submit()} loading={busy} disabled={!file || !!currencyError || newPersonIncomplete}>Upload</Button>
        </Stack>
      </Paper>
    </>
  );
}
