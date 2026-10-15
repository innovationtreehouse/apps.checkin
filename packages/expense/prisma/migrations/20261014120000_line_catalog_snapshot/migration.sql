-- AlterTable
ALTER TABLE "expense_line_items" ADD COLUMN "signed_gtin13" TEXT,
ADD COLUMN "signed_category" TEXT,
ADD COLUMN "signed_subcategory" TEXT;
