"use client";

import { useCallback, useRef, useState } from "react";
import { Alert, Button, Group, List, Modal, Select, Text } from "@mantine/core";
import type { CloseChoice, CloseChoiceWarning } from "@/lib/scan-service";

/** What the caller re-sends with its request once the person has chosen. */
export type CloseChoiceAnswer = { forceCloseToken: string; closeChoice: CloseChoice; handoverToId?: number };

export function isCloseChoiceWarning(body: unknown): body is CloseChoiceWarning {
    return typeof body === "object" && body !== null && (body as { type?: unknown }).type === "close_choice";
}

type Pending = { warning: CloseChoiceWarning; removal: boolean; resolve: (answer: CloseChoiceAnswer | null) => void };

/**
 * The one confirm for a web checkout, correction or removal of the last
 * keyholder's visit: close, leave or cancel, as the server allows. `ask`
 * resolves with the fields to re-send, or null on cancel.
 */
export function useCloseChoice() {
    const [pending, setPending] = useState<Pending | null>(null);
    const [handoverTo, setHandoverTo] = useState<string | null>(null);
    const pendingRef = useRef<Pending | null>(null);

    const ask = useCallback((warning: CloseChoiceWarning, opts: { removal?: boolean } = {}) =>
        new Promise<CloseChoiceAnswer | null>((resolve) => {
            const next = { warning, removal: !!opts.removal, resolve };
            pendingRef.current = next;
            setHandoverTo(null);
            setPending(next);
        }), []);

    const finish = (answer: CloseChoiceAnswer | null) => {
        pendingRef.current?.resolve(answer);
        pendingRef.current = null;
        setPending(null);
    };

    const warning = pending?.warning;
    const pickList = warning?.keyholders ?? null;
    const mustName = !!pickList && pickList.length > 0;
    const choose = (closeChoice: CloseChoice) => warning && finish({
        forceCloseToken: warning.forceCloseToken,
        closeChoice,
        ...(closeChoice === "leave" && handoverTo ? { handoverToId: Number(handoverTo) } : {}),
    });

    const dialog = (
        <Modal
            opened={!!pending}
            onClose={() => finish(null)}
            title={<Text span fw={700} fz="lg">{pending?.removal ? "Remove this visit?" : "Last keyholder checking out"}</Text>}
            centered
        >
            {warning && (
                <>
                    <Alert color="yellow" mb="md">{warning.error}</Alert>
                    {warning.names && warning.names.length > 0 && (
                        <>
                            <Text fw={600} size="sm">Still recorded inside:</Text>
                            <List size="sm" mb="md">
                                {warning.names.map((name, i) => <List.Item key={i}>{name}</List.Item>)}
                            </List>
                        </>
                    )}
                    {pickList && warning.choices.includes("leave") && (
                        mustName ? (
                            <Select
                                mb="md"
                                label="To leave, name the keyholder you handed over to"
                                placeholder="Choose a keyholder"
                                data={pickList.map(k => ({ value: String(k.id), label: k.name }))}
                                value={handoverTo}
                                onChange={setHandoverTo}
                            />
                        ) : (
                            <Text size="sm" c="dimmed" mb="md">No other keyholder is available to name; leaving records the handover as not named.</Text>
                        )
                    )}
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => finish(null)}>Cancel</Button>
                        {warning.choices.includes("leave") && (
                            <Button
                                color="orange"
                                disabled={mustName && !handoverTo}
                                onClick={() => choose("leave")}
                            >
                                {pending?.removal ? "Remove" : "Leave without closing"}
                            </Button>
                        )}
                        {warning.choices.includes("close") && (
                            <Button color="red" onClick={() => choose("close")}>Close facility</Button>
                        )}
                    </Group>
                </>
            )}
        </Modal>
    );

    return { ask, dialog };
}
