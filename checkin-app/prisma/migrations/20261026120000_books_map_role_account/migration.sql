-- The books map's account half: one QuickBooks account per named role.
-- Additive: a new table nothing reads yet.
BEGIN;

-- CreateTable
CREATE TABLE "BooksMapRoleAccount" (
    "role" TEXT NOT NULL,
    "quickBooksAccountId" TEXT NOT NULL,

    CONSTRAINT "BooksMapRoleAccount_pkey" PRIMARY KEY ("role")
);

COMMIT;
