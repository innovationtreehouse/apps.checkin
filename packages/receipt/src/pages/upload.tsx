"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
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
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { errorMessage, upload } from "../components/api";

interface Line {
  description: string;
  quantity: number | "";
  unitPrice: number | "";
}

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain";
const blankLine = (): Line => ({ description: "", quantity: 1, unitPrice: "" });

/**
 * /receipts/upload — a photo, PDF or text file, with the details typed or read automatically.
 * "I paid for this myself" is offered to adults only; the service enforces the same rule.
 */
export default function UploadPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const isAdult = (session?.user as { ageBand?: string } | undefined)?.ageBand === "adult";

  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [retailer, setRetailer] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [total, setTotal] = useState<number | "">("");
  const [tax, setTax] = useState<number | "">("");
  const [shipping, setShipping] = useState<number | "">("");
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [needsReimbursement, setNeedsReimbursement] = useState(false);
  const [isInKind, setIsInKind] = useState(false);
  const [selfDonor, setSelfDonor] = useState(true);
  const [donor, setDonor] = useState({ firstName: "", lastName: "", companyName: "" });
  const [busy, setBusy] = useState(false);

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    if (!file) return;
    const data = {
      needsReimbursement: !isInKind && needsReimbursement,
      isInKind,
      ...(isInKind ? { donor: selfDonor ? { self: true } : { ...donor, companyName: donor.companyName || null } } : {}),
      ...(mode === "manual"
        ? {
            details: {
              retailer,
              receiptDate,
              receiptTotal: String(total || 0),
              tax: String(tax || 0),
              shipping: String(shipping || 0),
              lineItems: lines.map((l) => ({ description: l.description, quantity: l.quantity || 1, unitPrice: l.unitPrice || 0 })),
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
      notifications.show({ message: errorMessage(err), color: "red" });
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
              <TextInput label="Date" type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.currentTarget.value)} required />
              <Group grow>
                <NumberInput label="Total" prefix="$" decimalScale={2} min={0} value={total} onChange={(v) => setTotal(typeof v === "number" ? v : "")} required />
                <NumberInput label="Tax" prefix="$" decimalScale={2} min={0} value={tax} onChange={(v) => setTax(typeof v === "number" ? v : "")} />
                <NumberInput label="Shipping" prefix="$" decimalScale={2} min={0} value={shipping} onChange={(v) => setShipping(typeof v === "number" ? v : "")} />
              </Group>
              <Text fw={500} size="sm">Items</Text>
              {lines.map((l, i) => (
                <Group key={i} align="end" wrap="nowrap">
                  <TextInput label={i === 0 ? "Description" : undefined} style={{ flex: 1 }} value={l.description} onChange={(e) => setLine(i, { description: e.currentTarget.value })} />
                  <NumberInput label={i === 0 ? "Qty" : undefined} w={80} min={0} value={l.quantity} onChange={(v) => setLine(i, { quantity: typeof v === "number" ? v : "" })} />
                  <NumberInput label={i === 0 ? "Unit price" : undefined} w={120} prefix="$" decimalScale={2} min={0} value={l.unitPrice} onChange={(v) => setLine(i, { unitPrice: typeof v === "number" ? v : "" })} />
                  <ActionIcon variant="subtle" color="red" aria-label="Remove item" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</ActionIcon>
                </Group>
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
            <Checkbox label="I paid for this myself" checked={needsReimbursement} onChange={(e) => setNeedsReimbursement(e.currentTarget.checked)} />
          )}
          <Button onClick={() => void submit()} loading={busy} disabled={!file}>Upload</Button>
        </Stack>
      </Paper>
    </>
  );
}
