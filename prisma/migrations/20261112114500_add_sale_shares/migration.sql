-- CreateTable
CREATE TABLE "sale_shares" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "customer_id" UUID,
    "payer_name" TEXT,
    "share_total" DECIMAL(12,2) NOT NULL,
    "cash_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "mpesa_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "debt_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_shares_sale_id_idx" ON "sale_shares"("sale_id");

-- CreateIndex
CREATE INDEX "sale_shares_customer_id_idx" ON "sale_shares"("customer_id");

-- AddForeignKey
ALTER TABLE "sale_shares" ADD CONSTRAINT "sale_shares_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_shares" ADD CONSTRAINT "sale_shares_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

