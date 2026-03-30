import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export default async function ExtractionsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const extractions = await prisma.extraction.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    omit: { pdfData: true, rawResponse: true },
    include: {
      _count: {
        select: {
          items: true,
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Extraction History</h1>
          <p className="text-muted-foreground mt-1">
            View and manage your past extractions
          </p>
        </div>
        <Link href="/extract">
          <Button>New Extraction</Button>
        </Link>
      </div>

      {extractions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">
              No extractions yet. Upload your first plan to get started.
            </p>
            <Link href="/extract">
              <Button>Upload Plan</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {extractions.map((extraction) => {
            const totalItems = extraction._count.items;

            return (
              <Link
                key={extraction.id}
                href={`/extractions/${extraction.id}`}
              >
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="space-y-1">
                      <p className="font-medium">{extraction.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {extraction.fileName} &middot;{" "}
                        {(extraction.fileSize / 1024 / 1024).toFixed(1)} MB
                        &middot;{" "}
                        {format(extraction.createdAt, "MMM d, yyyy 'at' h:mm a")}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="hidden text-right text-sm text-muted-foreground sm:block">
                        <span>{totalItems} items</span>
                      </div>
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
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
