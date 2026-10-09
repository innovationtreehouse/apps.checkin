export class ServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export class ReceiptStateConflictError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Receipt state conflict: expected '${expected}', found '${actual ?? "not_found"}'. Refresh and retry.`);
    this.name = "ReceiptStateConflictError";
  }
}
