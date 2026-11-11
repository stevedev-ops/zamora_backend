-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('PURCHASE_IN', 'SALE_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGED', 'EXPIRED', 'RETURN_IN', 'RETURN_OUT', 'OPENING_STOCK');

-- CreateEnum
CREATE TYPE "SalePaymentMethod" AS ENUM ('CASH', 'MPESA', 'CREDIT', 'SPLIT');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'MPESA', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('POS_SALE', 'DEBT_REPAYMENT');

-- CreateEnum
CREATE TYPE "DebtTransactionType" AS ENUM ('CREDIT_SALE', 'PAYMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT', 'REVERSAL', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "DebtTransferStatus" AS ENUM ('PENDING_ACCEPTANCE', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('RENT', 'ELECTRICITY', 'WATER', 'TRANSPORT', 'SALARIES', 'LICENCES', 'REPAIRS', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('CREDIT_SALE', 'PAYMENT_RECEIVED', 'DEBT_TRANSFER_REQUEST', 'DEBT_TRANSFER_COMPLETED', 'DEBT_TRANSFER_REJECTED', 'DEBT_ADJUSTMENT', 'PAYMENT_OVERDUE', 'LOW_STOCK', 'PORTAL_OTP', 'CLARIFICATION_REQUEST');

-- CreateEnum
CREATE TYPE "ClarificationStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MpesaPurpose" AS ENUM ('POS_SALE', 'DEBT_REPAYMENT', 'PORTAL_REPAYMENT');

-- CreateEnum
CREATE TYPE "MpesaStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('OWNER', 'CUSTOMER_PORTAL', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "supplier_id" UUID,
    "image_url" TEXT,
    "barcode" TEXT,
    "bottle_size" TEXT NOT NULL,
    "purchase_price" DECIMAL(12,2) NOT NULL,
    "selling_price" DECIMAL(12,2) NOT NULL,
    "current_stock" INTEGER NOT NULL DEFAULT 0,
    "min_stock_alert" INTEGER NOT NULL DEFAULT 5,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_purchases" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_cost" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_purchase_items" (
    "id" UUID NOT NULL,
    "supplier_purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_price" DECIMAL(12,2) NOT NULL,
    "total_cost" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_id" UUID,
    "supplier_purchase_item_id" UUID,
    "purchase_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initial_quantity" INTEGER NOT NULL,
    "remaining_quantity" INTEGER NOT NULL,
    "unit_cost_price" DECIMAL(12,2) NOT NULL,
    "total_cost" DECIMAL(12,2) NOT NULL,
    "reference_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "inventory_batch_id" UUID,
    "movement_type" "InventoryMovementType" NOT NULL,
    "quantity_change" INTEGER NOT NULL,
    "quantity_before" INTEGER NOT NULL,
    "quantity_after" INTEGER NOT NULL,
    "unit_cost_price" DECIMAL(12,2) NOT NULL,
    "total_cost_value" DECIMAL(12,2) NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "reason" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "current_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit_limit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_purchases" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_payments" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_transferred_in" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_transferred_out" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "last_transaction_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_limits" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "limit_amount" DECIMAL(12,2) NOT NULL,
    "previous_limit" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "set_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "customer_id" UUID,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "cash_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "mpesa_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "mpesa_reference" TEXT,
    "amount_paid" DECIMAL(12,2) NOT NULL,
    "outstanding_amount" DECIMAL(12,2) NOT NULL,
    "total_cost" DECIMAL(12,2) NOT NULL,
    "gross_profit" DECIMAL(12,2) NOT NULL,
    "payment_method" "SalePaymentMethod" NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "notes" TEXT,
    "idempotency_key" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "sold_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "bottle_size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_selling_price" DECIMAL(12,2) NOT NULL,
    "unit_cost_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    "line_cost" DECIMAL(12,2) NOT NULL,
    "line_profit" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_item_batch_allocations" (
    "id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "inventory_batch_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_price" DECIMAL(12,2) NOT NULL,
    "total_cost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "sale_item_batch_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "customer_id" UUID,
    "sale_id" UUID,
    "payment_type" "PaymentType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "mpesa_reference" TEXT,
    "mpesa_checkout_request_id" TEXT,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "received_by_user_id" UUID,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_transfers" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "from_customer_id" UUID NOT NULL,
    "to_customer_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DebtTransferStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "confirmation_token_hash" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "otp_expires_at" TIMESTAMP(3) NOT NULL,
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "accepted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "accepted_method" TEXT,
    "idempotency_key" TEXT,
    "initiated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debt_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_transactions" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "transaction_type" "DebtTransactionType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "running_balance" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT,
    "sale_id" UUID,
    "payment_id" UUID,
    "debt_transfer_id" UUID,
    "reversed_transaction_id" UUID,
    "is_reversed" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expense_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_method" "PaymentMethod" NOT NULL,
    "payee" TEXT,
    "notes" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "event_type" "NotificationEventType" NOT NULL,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error_message" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_portal_tokens" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_portal_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_otp_challenges" (
    "id" UUID NOT NULL,
    "portal_token_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clarification_requests" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "debt_transaction_id" UUID,
    "sale_id" UUID,
    "message" TEXT NOT NULL,
    "status" "ClarificationStatus" NOT NULL DEFAULT 'OPEN',
    "owner_response" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clarification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mpesa_transactions" (
    "id" UUID NOT NULL,
    "merchant_request_id" TEXT,
    "checkout_request_id" TEXT NOT NULL,
    "purpose" "MpesaPurpose" NOT NULL,
    "customer_id" UUID,
    "sale_id" UUID,
    "phone_number" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "MpesaStatus" NOT NULL DEFAULT 'PENDING',
    "mpesa_receipt_number" TEXT,
    "result_code" INTEGER,
    "result_desc" TEXT,
    "raw_callback" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mpesa_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" TEXT,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "store_name" TEXT NOT NULL DEFAULT 'Zamora Liquor Store',
    "store_phone" TEXT NOT NULL DEFAULT '+254700000000',
    "store_email" TEXT,
    "store_address" TEXT NOT NULL DEFAULT 'Nairobi, Kenya',
    "currency" TEXT NOT NULL DEFAULT 'KSh',
    "receipt_footer" TEXT NOT NULL DEFAULT 'Thank you for shopping with us! Drink responsibly.',
    "mpesa_enabled" BOOLEAN NOT NULL DEFAULT true,
    "mpesa_paybill_or_till" TEXT,
    "mpesa_account_reference" TEXT,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_credit_limit" DECIMAL(12,2) NOT NULL DEFAULT 5000,
    "low_stock_default_alert" INTEGER NOT NULL DEFAULT 5,
    "overdue_days_threshold" INTEGER NOT NULL DEFAULT 14,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_counters" (
    "name" TEXT NOT NULL,
    "current_value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_counters_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "products_brand_idx" ON "products"("brand");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_purchases_reference_number_key" ON "supplier_purchases"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_purchases_idempotency_key_key" ON "supplier_purchases"("idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_purchases_supplier_id_purchase_date_idx" ON "supplier_purchases"("supplier_id", "purchase_date");

-- CreateIndex
CREATE INDEX "supplier_purchase_items_supplier_purchase_id_idx" ON "supplier_purchase_items"("supplier_purchase_id");

-- CreateIndex
CREATE INDEX "supplier_purchase_items_product_id_idx" ON "supplier_purchase_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_batch_number_key" ON "inventory_batches"("batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_supplier_purchase_item_id_key" ON "inventory_batches"("supplier_purchase_item_id");

-- CreateIndex
CREATE INDEX "inventory_batches_product_id_remaining_quantity_purchase_da_idx" ON "inventory_batches"("product_id", "remaining_quantity", "purchase_date");

-- CreateIndex
CREATE INDEX "inventory_movements_product_id_created_at_idx" ON "inventory_movements"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_movement_type_idx" ON "inventory_movements"("movement_type");

-- CreateIndex
CREATE UNIQUE INDEX "customers_account_number_key" ON "customers"("account_number");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_full_name_idx" ON "customers"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_customer_id_key" ON "customer_accounts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_accounts_current_balance_idx" ON "customer_accounts"("current_balance");

-- CreateIndex
CREATE INDEX "credit_limits_customer_id_is_active_idx" ON "credit_limits"("customer_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "sales_receipt_number_key" ON "sales"("receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_idempotency_key_key" ON "sales"("idempotency_key");

-- CreateIndex
CREATE INDEX "sales_sold_at_idx" ON "sales"("sold_at");

-- CreateIndex
CREATE INDEX "sales_customer_id_sold_at_idx" ON "sales"("customer_id", "sold_at");

-- CreateIndex
CREATE INDEX "sales_payment_method_idx" ON "sales"("payment_method");

-- CreateIndex
CREATE INDEX "sale_items_sale_id_idx" ON "sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- CreateIndex
CREATE INDEX "sale_item_batch_allocations_sale_item_id_idx" ON "sale_item_batch_allocations"("sale_item_id");

-- CreateIndex
CREATE INDEX "sale_item_batch_allocations_inventory_batch_id_idx" ON "sale_item_batch_allocations"("inventory_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reference_number_key" ON "payments"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_customer_id_paid_at_idx" ON "payments"("customer_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "debt_transfers_reference_number_key" ON "debt_transfers"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "debt_transfers_confirmation_token_hash_key" ON "debt_transfers"("confirmation_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "debt_transfers_idempotency_key_key" ON "debt_transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "debt_transfers_from_customer_id_status_idx" ON "debt_transfers"("from_customer_id", "status");

-- CreateIndex
CREATE INDEX "debt_transfers_to_customer_id_status_idx" ON "debt_transfers"("to_customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "debt_transactions_reference_number_key" ON "debt_transactions"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "debt_transactions_reversed_transaction_id_key" ON "debt_transactions"("reversed_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "debt_transactions_idempotency_key_key" ON "debt_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "debt_transactions_customer_id_created_at_idx" ON "debt_transactions"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "debt_transactions_transaction_type_idx" ON "debt_transactions"("transaction_type");

-- CreateIndex
CREATE INDEX "debt_transactions_sale_id_idx" ON "debt_transactions"("sale_id");

-- CreateIndex
CREATE INDEX "debt_transactions_payment_id_idx" ON "debt_transactions"("payment_id");

-- CreateIndex
CREATE INDEX "debt_transactions_debt_transfer_id_idx" ON "debt_transactions"("debt_transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_reference_number_key" ON "expenses"("reference_number");

-- CreateIndex
CREATE INDEX "expenses_expense_date_idx" ON "expenses"("expense_date");

-- CreateIndex
CREATE INDEX "expenses_category_idx" ON "expenses"("category");

-- CreateIndex
CREATE INDEX "notifications_customer_id_created_at_idx" ON "notifications"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_event_type_created_at_idx" ON "notifications"("event_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_portal_tokens_token_key" ON "customer_portal_tokens"("token");

-- CreateIndex
CREATE INDEX "customer_portal_tokens_customer_id_revoked_at_idx" ON "customer_portal_tokens"("customer_id", "revoked_at");

-- CreateIndex
CREATE INDEX "portal_otp_challenges_portal_token_id_created_at_idx" ON "portal_otp_challenges"("portal_token_id", "created_at");

-- CreateIndex
CREATE INDEX "clarification_requests_customer_id_status_idx" ON "clarification_requests"("customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_checkout_request_id_key" ON "mpesa_transactions"("checkout_request_id");

-- CreateIndex
CREATE INDEX "mpesa_transactions_customer_id_status_idx" ON "mpesa_transactions"("customer_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_supplier_purchase_id_fkey" FOREIGN KEY ("supplier_purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_supplier_purchase_item_id_fkey" FOREIGN KEY ("supplier_purchase_item_id") REFERENCES "supplier_purchase_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_batch_id_fkey" FOREIGN KEY ("inventory_batch_id") REFERENCES "inventory_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_limits" ADD CONSTRAINT "credit_limits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_limits" ADD CONSTRAINT "credit_limits_set_by_user_id_fkey" FOREIGN KEY ("set_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item_batch_allocations" ADD CONSTRAINT "sale_item_batch_allocations_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item_batch_allocations" ADD CONSTRAINT "sale_item_batch_allocations_inventory_batch_id_fkey" FOREIGN KEY ("inventory_batch_id") REFERENCES "inventory_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_user_id_fkey" FOREIGN KEY ("received_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transfers" ADD CONSTRAINT "debt_transfers_from_customer_id_fkey" FOREIGN KEY ("from_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transfers" ADD CONSTRAINT "debt_transfers_to_customer_id_fkey" FOREIGN KEY ("to_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transfers" ADD CONSTRAINT "debt_transfers_initiated_by_user_id_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_debt_transfer_id_fkey" FOREIGN KEY ("debt_transfer_id") REFERENCES "debt_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_reversed_transaction_id_fkey" FOREIGN KEY ("reversed_transaction_id") REFERENCES "debt_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_transactions" ADD CONSTRAINT "debt_transactions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_tokens" ADD CONSTRAINT "customer_portal_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_otp_challenges" ADD CONSTRAINT "portal_otp_challenges_portal_token_id_fkey" FOREIGN KEY ("portal_token_id") REFERENCES "customer_portal_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_otp_challenges" ADD CONSTRAINT "portal_otp_challenges_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_debt_transaction_id_fkey" FOREIGN KEY ("debt_transaction_id") REFERENCES "debt_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarification_requests" ADD CONSTRAINT "clarification_requests_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
