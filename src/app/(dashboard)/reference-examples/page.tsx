import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ExamplesList } from "@/components/reference-examples/examples-list";

export default async function ReferenceExamplesPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const referenceExamples = await prisma.referenceExample.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  // Serialize dates for client component
  const serialized = referenceExamples.map((ex) => ({
    ...ex,
    createdAt: ex.createdAt.toISOString(),
    updatedAt: ex.updatedAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <ExamplesList initialExamples={serialized} />
    </div>
  );
}
