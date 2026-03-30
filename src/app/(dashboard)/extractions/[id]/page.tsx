import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { ExportButtons } from "@/components/export/export-buttons";
import { DeleteButton } from "@/components/extraction/delete-button";
import { CompletenessAudit } from "@/components/extraction/completeness-audit";

export default async function ExtractionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;

  const { id } = await params;

  const extraction = await prisma.extraction.findUnique({
    where: { id },
    omit: { pdfData: true },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!extraction || extraction.userId !== session.user.id) {
    notFound();
  }

  const totalItems = extraction.items.length;
  const areaItems = extraction.items.filter(
    (i) => i.measurementType === "area"
  );
  const countItems = extraction.items.filter(
    (i) => i.measurementType === "count"
  );
  const linearItems = extraction.items.filter(
    (i) => i.measurementType === "linear"
  );

  const areaSqFt = areaItems.reduce((sum, i) => sum + i.quantity, 0);
  const linearFt = linearItems.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{extraction.name}</h1>
            <Badge
              variant={
                extraction.status === "completed"
                  ? "default"
                  : extraction.status === "failed"
                  ? "destructive"
                  : "secondary"
              }
            >
              {extraction.status}
            </Badge>
            {extraction.verified && (
              <Badge
                variant="outline"
                className="border-green-500 text-green-700"
              >
                Verified
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1">
            {extraction.fileName} &middot;{" "}
            {(extraction.fileSize / 1024 / 1024).toFixed(1)} MB &middot;{" "}
            {format(extraction.createdAt, "MMM d, yyyy 'at' h:mm a")}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/extractions/${extraction.id}/measure`}>
            <Button variant="outline">Measure</Button>
          </Link>
          <ExportButtons extractionId={extraction.id} />
          <DeleteButton extractionId={extraction.id} />
        </div>
      </div>

      {extraction.summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Project Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {extraction.summary}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Items</CardDescription>
            <CardTitle className="text-2xl">{totalItems}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Area</CardDescription>
            <CardTitle className="text-2xl">{areaItems.length}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              {areaSqFt.toFixed(1)} SQ FT
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Count</CardDescription>
            <CardTitle className="text-2xl">{countItems.length}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              {countItems.reduce((sum, i) => sum + i.quantity, 0)} total units
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Linear</CardDescription>
            <CardTitle className="text-2xl">{linearItems.length}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              {linearFt.toFixed(1)} FT
            </p>
          </CardContent>
        </Card>
      </div>

      {extraction.status === "failed" && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-lg text-destructive">
              Extraction Failed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {extraction.errorMessage || "An unknown error occurred during extraction."}
            </p>
            <Link href="/extract" className="mt-4 inline-block">
              <Button variant="outline">Try Again</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {totalItems > 0 && (
        <>
          <CompletenessAudit
            items={extraction.items.map((i) => ({
              name: i.name,
              system: i.system,
              measurementType: i.measurementType,
              quantity: i.quantity,
            }))}
          />
          <Separator />
          <InventoryTabs items={extraction.items} extractionId={extraction.id} />
        </>
      )}
    </div>
  );
}
