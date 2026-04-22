import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  parsePlanSwiftReference,
  diffExtractionAgainstReference,
} from "@/lib/planswift-csv";

/**
 * POST /api/extractions/[id]/compare
 *
 * Body (multipart form):
 *   - file: uploaded PlanSwift CSV / text export
 *
 * OR JSON body:
 *   - referenceText: string (raw CSV text)
 *
 * Parses the reference takeoff, loads all items from the extraction, and
 * returns a diff showing:
 *   - exact matches (same name + qty within 5%)
 *   - close matches (same name + qty within 25%)
 *   - quantity mismatches (same name + qty off by >25%)
 *   - missing items (in reference but not extraction)
 *   - extra items (in extraction but not reference)
 *
 * Plus a summary scorecard.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Check extraction ownership
  const extraction = await prisma.extraction.findUnique({
    where: { id },
    select: {
      userId: true,
      name: true,
      items: true,
    },
  });
  if (!extraction || extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Parse the reference — support both multipart upload and JSON text
  let referenceText = "";
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: "No file uploaded in 'file' field" },
          { status: 400 }
        );
      }
      referenceText = await file.text();
    } else if (contentType.includes("application/json")) {
      const body = await req.json();
      referenceText = body.referenceText || "";
    } else {
      return NextResponse.json(
        {
          error:
            "Content-Type must be multipart/form-data (file upload) or application/json",
        },
        { status: 400 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Failed to read request body: ${err.message}`
            : "Failed to read request body",
      },
      { status: 400 }
    );
  }

  if (!referenceText.trim()) {
    return NextResponse.json(
      { error: "Reference file is empty" },
      { status: 400 }
    );
  }

  // Parse the PlanSwift export
  const { items: reference, errors: parseErrors } =
    parsePlanSwiftReference(referenceText);

  if (reference.length === 0) {
    return NextResponse.json(
      {
        error:
          "No items parsed from the reference file. Expected PlanSwift-style format with 'Type: Area/Count/Linear' section headers.",
        parseErrors,
      },
      { status: 400 }
    );
  }

  // Run the diff
  const result = diffExtractionAgainstReference(reference, extraction.items);

  return NextResponse.json({
    extractionName: extraction.name,
    referenceItemCount: reference.length,
    parseErrors,
    ...result,
  });
}
