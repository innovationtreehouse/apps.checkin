-- AlterTable
ALTER TABLE "BoardSettings" ADD COLUMN "releasedLibraries" TEXT[] DEFAULT ARRAY[]::TEXT[];
