import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";
import { apiKeySettingsSchema } from "@/lib/validators";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        anthropicKeyEnc: true,
        openaiKeyEnc: true,
        geminiKeyEnc: true,
        preferredProvider: true,
        customInstructions: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({
      hasAnthropicKey: !!user.anthropicKeyEnc,
      hasOpenaiKey: !!user.openaiKeyEnc,
      hasGeminiKey: !!user.geminiKeyEnc,
      preferredProvider: user.preferredProvider,
      customInstructions: user.customInstructions || "",
    });
  } catch (error) {
    console.error("Settings GET error:", error);
    return NextResponse.json(
      { error: "Failed to load settings" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    console.log("[settings] PUT body keys:", Object.keys(body));

    const parsed = apiKeySettingsSchema.safeParse(body);

    if (!parsed.success) {
      console.error("[settings] Validation failed:", parsed.error.flatten());
      return NextResponse.json(
        { error: "Invalid settings data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { anthropicKey, openaiKey, geminiKey, preferredProvider, customInstructions } =
      parsed.data;

    // Build update object — only update fields that were provided
    const updateData: Record<string, string | null> = {
      preferredProvider,
    };

    // Handle customInstructions: string → store trimmed, null/empty → clear, undefined → skip
    if (customInstructions !== undefined) {
      updateData.customInstructions =
        customInstructions && customInstructions.trim()
          ? customInstructions.trim()
          : null;
    }

    // For each key: string → encrypt & store, null → clear, undefined → skip
    if (anthropicKey !== undefined) {
      try {
        updateData.anthropicKeyEnc =
          anthropicKey && anthropicKey.trim()
            ? encrypt(anthropicKey.trim())
            : null;
      } catch (encErr) {
        console.error("[settings] Failed to encrypt Anthropic key:", encErr);
        return NextResponse.json(
          {
            error: `Encryption failed: ${encErr instanceof Error ? encErr.message : "Unknown error"}`,
          },
          { status: 500 }
        );
      }
    }

    if (openaiKey !== undefined) {
      try {
        updateData.openaiKeyEnc =
          openaiKey && openaiKey.trim() ? encrypt(openaiKey.trim()) : null;
      } catch (encErr) {
        console.error("[settings] Failed to encrypt OpenAI key:", encErr);
        return NextResponse.json(
          {
            error: `Encryption failed: ${encErr instanceof Error ? encErr.message : "Unknown error"}`,
          },
          { status: 500 }
        );
      }
    }

    if (geminiKey !== undefined) {
      try {
        updateData.geminiKeyEnc =
          geminiKey && geminiKey.trim() ? encrypt(geminiKey.trim()) : null;
      } catch (encErr) {
        console.error("[settings] Failed to encrypt Gemini key:", encErr);
        return NextResponse.json(
          {
            error: `Encryption failed: ${encErr instanceof Error ? encErr.message : "Unknown error"}`,
          },
          { status: 500 }
        );
      }
    }

    try {
      await prisma.user.update({
        where: { id: session.user.id },
        data: updateData,
      });
    } catch (dbErr) {
      console.error("[settings] Database update failed:", dbErr);
      return NextResponse.json(
        {
          error: `Database error: ${dbErr instanceof Error ? dbErr.message : "Unknown error"}`,
        },
        { status: 500 }
      );
    }

    // Return updated state
    const updatedUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        anthropicKeyEnc: true,
        openaiKeyEnc: true,
        geminiKeyEnc: true,
        preferredProvider: true,
        customInstructions: true,
      },
    });

    return NextResponse.json({
      hasAnthropicKey: !!updatedUser?.anthropicKeyEnc,
      hasOpenaiKey: !!updatedUser?.openaiKeyEnc,
      hasGeminiKey: !!updatedUser?.geminiKeyEnc,
      preferredProvider: updatedUser?.preferredProvider,
      customInstructions: updatedUser?.customInstructions || "",
    });
  } catch (error) {
    console.error("[settings] PUT unexpected error:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to save settings: ${message}` },
      { status: 500 }
    );
  }
}
