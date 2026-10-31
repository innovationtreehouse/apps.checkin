/**
 * One person, and one household, signs one step of an expense, across its lines, against the real
 * database: the line approval, the Treasurer seat, the Board seat and the Board authorization.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, seedSubmitterSeat } from "../helpers/seed";
import { recordBoardAuthorization, signLine } from "../../services/signoffService";
import { approveLine, financeAssign } from "../../services/approvalService";

const refused = (pattern: RegExp) => ({ status: 403, message: expect.stringMatching(pattern) });

describeDb("one step per signer across an expense's lines", () => {
  // Bucket 100 is approved by 2, bucket 101 by 3. 3, 4 and 9 hold FINANCE; 3 and 4 share a household.
  async function cardCharge() {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [3] }, finance: [3, 4, 9], households: [[3, 4]] }) });
    const id = await seedExpense({ state: "owner_approval" });
    const [a, b] = [await seedLineItem(id), await seedLineItem(id)];
    return { id, a, b, approvalA: await seedApproval(id, a, { ownerId: 100 }), approvalB: await seedApproval(id, b, { ownerId: 101 }) };
  }

  it("on a card charge, whoever approved another line, and their household, does not sign the Treasurer seat", async () => {
    const { id, a, approvalA, approvalB } = await cardCharge();
    await approveLine(principal(3, { isFinance: true }), id, approvalB);
    await approveLine(principal(2), id, approvalA);

    await expect(signLine(principal(3, { isFinance: true }), a, "TREASURER")).rejects.toMatchObject(refused(/another step/));
    await expect(signLine(principal(4, { isFinance: true }), a, "TREASURER")).rejects.toMatchObject(refused(/household/));
    await signLine(principal(9, { isFinance: true }), a, "TREASURER");
  });

  it("on a card charge, whoever signed the Treasurer seat on one line does not approve another", async () => {
    const { id, a, approvalA, approvalB } = await cardCharge();
    await approveLine(principal(2), id, approvalA);
    await signLine(principal(3, { isFinance: true }), a, "TREASURER");

    await expect(approveLine(principal(3, { isFinance: true }), id, approvalB)).rejects.toMatchObject(refused(/later step/));
  });

  it("on a reimbursement, the Board seat refuses an earlier signer and their household", async () => {
    // Reimbursee 1 holds no membership, so each line takes the Board seat. Board member 7 approves
    // bucket 101; Board member 6 shares a household with Treasurer 3.
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [7] }, finance: [3], board: [5, 6, 7], households: [[3, 6]], nonMembers: [1] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const [a, b] = [await seedLineItem(id), await seedLineItem(id)];
    const [approvalA, approvalB] = [await seedApproval(id, a, { ownerId: 100 }), await seedApproval(id, b, { ownerId: 101 })];
    for (const li of [a, b]) await seedSubmitterSeat(li, 1);
    await approveLine(principal(2), id, approvalA);
    await approveLine(principal(7, { isBoard: true }), id, approvalB);
    await signLine(principal(3, { isFinance: true }), a, "TREASURER");

    await expect(signLine(principal(7, { isBoard: true }), a, "BOARD")).rejects.toMatchObject(refused(/another step/));
    await expect(signLine(principal(6, { isBoard: true }), a, "BOARD")).rejects.toMatchObject(refused(/household/));
    await signLine(principal(5, { isBoard: true }), a, "BOARD");
  });

  it("whoever signed the Treasurer seat does not record the Board authorization", async () => {
    // A non-Everyday org-level card charge takes the Board seat; Board member 6 approves it.
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3, 4], board: [5, 6] }) });
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 60_000 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await approveLine(principal(6, { isBoard: true }), id, await seedApproval(id, li, { ownerId: 7 }));
    await signLine(principal(3, { isFinance: true }), li, "TREASURER");

    await expect(recordBoardAuthorization(principal(3, { isFinance: true }), id, "Board minutes, item 4")).rejects.toMatchObject(refused(/earlier step/));
    await recordBoardAuthorization(principal(4, { isFinance: true }), id, "Board minutes, item 4");
  });

  it("whoever recorded the Board authorization first, and their household, signs no earlier step", async () => {
    // A non-Everyday card charge in org-level bucket 7, approved by bucket approver 2. FINANCE 3
    // records the authorization before the Treasurer seat; 4 shares their household; 9 holds FINANCE.
    bindPorts({ signoff: directory({ orgLevel: [7], approvers: { 7: [2, 3] }, finance: [3, 4, 9], board: [5], households: [[3, 4]] }) });
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 60_000 });
    const [a, b] = [await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" }), await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" })];
    const [approvalA, approvalB] = [await seedApproval(id, a, { ownerId: 7 }), await seedApproval(id, b, { ownerId: 7 })];
    await recordBoardAuthorization(principal(3, { isFinance: true }), id, "Board minutes, item 5");

    await expect(approveLine(principal(3, { isFinance: true }), id, approvalB)).rejects.toMatchObject(refused(/later step/));
    await approveLine(principal(2), id, approvalA);
    await expect(signLine(principal(3, { isFinance: true }), a, "TREASURER")).rejects.toMatchObject(refused(/another step/));
    await expect(signLine(principal(4, { isFinance: true }), a, "TREASURER")).rejects.toMatchObject(refused(/household/));
    await signLine(principal(9, { isFinance: true }), a, "TREASURER");
  });

  it("whoever moved a line out of an exception signs at the Treasurer step: they do not approve it, and their household takes no Board seat", async () => {
    // Reimbursee 1 holds no membership, so the line takes the Board seat. FINANCE 3 is also an
    // approver of bucket 101; Board member 6 shares their household.
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [3, 7] }, finance: [3, 9], board: [5, 6], households: [[3, 6]], nonMembers: [1] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { ownerId: 100, status: "exception_raised" });
    await financeAssign(principal(3, { isFinance: true }), id, approvalId, 101);
    await seedSubmitterSeat(li, 1);

    await expect(approveLine(principal(3, { isFinance: true }), id, approvalId)).rejects.toMatchObject(refused(/later step/));
    await approveLine(principal(7), id, approvalId);
    await signLine(principal(3, { isFinance: true }), li, "TREASURER");
    await expect(signLine(principal(6, { isBoard: true }), li, "BOARD")).rejects.toMatchObject(refused(/household/));
    await signLine(principal(5, { isBoard: true }), li, "BOARD");
  });
});
