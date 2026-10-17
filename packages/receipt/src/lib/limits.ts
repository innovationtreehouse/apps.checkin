// Daily intake limits. Each window is the rolling 24 hours before the request.

export interface ReceiptLimits {
  /** Uploads one person may make; mailed receipts count toward it. */
  uploadsPerPersonPerDay: number;
  /** Mailed receipts one person may add. */
  mailUploadsPerPersonPerDay: number;
  /** Mailed receipts a program lead or Board member may add. */
  mailUploadsPerRaisedPersonPerDay: number;
  /** Stored file bytes one person may add. */
  uploadBytesPerPersonPerDay: number;
  /** Stored file bytes the whole org may add. */
  uploadBytesPerDay: number;
  /** Model calls (auto upload and retry) one person may make. */
  ocrCallsPerPersonPerDay: number;
}

const MB = 1024 * 1024;

export const DEFAULT_LIMITS: ReceiptLimits = {
  uploadsPerPersonPerDay: 30,
  mailUploadsPerPersonPerDay: 5,
  mailUploadsPerRaisedPersonPerDay: 25,
  uploadBytesPerPersonPerDay: 100 * MB,
  uploadBytesPerDay: 500 * MB,
  ocrCallsPerPersonPerDay: 50,
};

export const DAY_MS = 24 * 60 * 60 * 1000;
