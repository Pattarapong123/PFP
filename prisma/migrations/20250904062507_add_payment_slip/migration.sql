-- CreateTable
CREATE TABLE "PaymentSlip" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "imageUrl" TEXT,
    "amountBaht" REAL,
    "verifiedStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "parsedPayload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
