-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Extraction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "rawResponse" TEXT,
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Extraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Pipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "material" TEXT NOT NULL,
    "diameter" REAL NOT NULL,
    "diameterUnit" TEXT NOT NULL DEFAULT 'in',
    "length" REAL NOT NULL,
    "lengthUnit" TEXT NOT NULL DEFAULT 'ft',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "location" TEXT,
    "extractionId" TEXT NOT NULL,
    CONSTRAINT "Pipe_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Fitting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "angle" REAL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "location" TEXT,
    "extractionId" TEXT NOT NULL,
    CONSTRAINT "Fitting_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Valve" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "size" REAL NOT NULL,
    "sizeUnit" TEXT NOT NULL DEFAULT 'in',
    "material" TEXT,
    "operationType" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "location" TEXT,
    "extractionId" TEXT NOT NULL,
    CONSTRAINT "Valve_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Hydrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "brand" TEXT,
    "color" TEXT,
    "connectionSize" REAL,
    "buryDepth" REAL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "location" TEXT,
    "extractionId" TEXT NOT NULL,
    CONSTRAINT "Hydrant_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "material" TEXT,
    "size" REAL,
    "sizeUnit" TEXT NOT NULL DEFAULT 'in',
    "meterSize" TEXT,
    "connectionType" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "location" TEXT,
    "extractionId" TEXT NOT NULL,
    CONSTRAINT "ServiceConnection_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Extraction_userId_idx" ON "Extraction"("userId");

-- CreateIndex
CREATE INDEX "Extraction_createdAt_idx" ON "Extraction"("createdAt");

-- CreateIndex
CREATE INDEX "Pipe_extractionId_idx" ON "Pipe"("extractionId");

-- CreateIndex
CREATE INDEX "Fitting_extractionId_idx" ON "Fitting"("extractionId");

-- CreateIndex
CREATE INDEX "Valve_extractionId_idx" ON "Valve"("extractionId");

-- CreateIndex
CREATE INDEX "Hydrant_extractionId_idx" ON "Hydrant"("extractionId");

-- CreateIndex
CREATE INDEX "ServiceConnection_extractionId_idx" ON "ServiceConnection"("extractionId");
