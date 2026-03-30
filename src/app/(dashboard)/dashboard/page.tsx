import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const recentExtractions = await prisma.extraction.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    omit: { pdfData: true, rawResponse: true },
    include: {
      _count: {
        select: {
          items: true,
        },
      },
    },
  });

  const totalExtractions = await prisma.extraction.count({
    where: { userId: session.user.id },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">
          Welcome back{session.user.name ? `, ${session.user.name}` : ""}
        </h1>
        <p className="text-muted-foreground mt-1">
          Upload construction plans and extract quantity takeoffs
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Extractions</CardDescription>
            <CardTitle className="text-4xl">{totalExtractions}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Completed</CardDescription>
            <CardTitle className="text-4xl">
              {recentExtractions.filter((e) => e.status === "completed").length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-primary">
          <CardHeader className="pb-2">
            <CardDescription>Quick Action</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/extract">
              <Button className="w-full">Upload New Plan</Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4">Recent Extractions</h2>
        {recentExtractions.length === 0 ? (
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
            {recentExtractions.map((extraction) => {
              const totalItems = extraction._count.items;

              return (
                <Link
                  key={extraction.id}
                  href={`/extractions/${extraction.id}`}
                >
                  <Card className="transition-colors hover:bg-muted/50">
                    <CardContent className="flex items-center justify-between py-4">
                      <div>
                        <p className="font-medium">{extraction.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {extraction.fileName} &middot;{" "}
                          {format(extraction.createdAt, "MMM d, yyyy")}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground">
                          {totalItems} items
                        </span>
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
    </div>
  );
}
