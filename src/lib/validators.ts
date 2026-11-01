import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const signupRequestSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  email: z.string().email("Invalid email address").max(200, "Email too long"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200, "Password too long"),
  company: z.string().max(120, "Company name too long").optional(),
  note: z.string().max(1000, "Message must be 1000 characters or fewer").optional(),
});

export const signupReviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reviewNote: z.string().max(1000, "Note must be 1000 characters or fewer").optional(),
});

export type SignupRequestInput = z.infer<typeof signupRequestSchema>;
export type SignupReviewInput = z.infer<typeof signupReviewSchema>;

export const referenceExampleSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  projectType: z.enum(["water", "storm_drain", "wastewater", "mixed", "other"]),
  rawText: z.string().min(10, "Paste your PlanSwift output (at least 10 characters)"),
  isActive: z.boolean().optional(),
});

export type ReferenceExampleInput = z.infer<typeof referenceExampleSchema>;

export const providerEnum = z.enum(["anthropic", "openai", "gemini"]);
export type Provider = z.infer<typeof providerEnum>;

export const apiKeySettingsSchema = z.object({
  anthropicKey: z.string().nullable().optional(),
  openaiKey: z.string().nullable().optional(),
  geminiKey: z.string().nullable().optional(),
  preferredProvider: providerEnum,
  // Model preferences per provider (null = use default)
  geminiModel: z.string().nullable().optional(),
  claudeModel: z.string().nullable().optional(),
  openaiModel: z.string().nullable().optional(),
  customInstructions: z
    .string()
    .max(4000, "Custom instructions must be 4000 characters or fewer")
    .nullable()
    .optional(),
});

export type ApiKeySettingsInput = z.infer<typeof apiKeySettingsSchema>;
