export class ServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** The 429 for the org-wide daily upload limit, which refuses every uploader alike. */
export class OrgUploadLimitError extends ServiceError {
  constructor() {
    super(429, "Receipt uploads have reached today's limit. Try again tomorrow.");
    this.name = "OrgUploadLimitError";
  }
}

export class ReceiptStateConflictError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Receipt state conflict: expected '${expected}', found '${actual ?? "not_found"}'. Refresh and retry.`);
    this.name = "ReceiptStateConflictError";
  }
}
