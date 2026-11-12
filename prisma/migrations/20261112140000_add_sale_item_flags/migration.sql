-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN "is_flagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "flag_note" TEXT,
ADD COLUMN "flagged_by_type" TEXT,
ADD COLUMN "flagged_at" TIMESTAMP(3);

