-- What the daily reversal and seat checks last saw on an exception's order. Empty on
-- existing rows; the release serving the drain window never reads it.
ALTER TABLE "PaymentException" ADD COLUMN "evidence" TEXT;
