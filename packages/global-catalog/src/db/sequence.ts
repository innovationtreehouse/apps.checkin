import { prisma } from "./index";

export async function nextProvisionalSequenceId(): Promise<number> {
  const row = await prisma.provisionalPartSequence.create({ data: {} });
  return row.id;
}
