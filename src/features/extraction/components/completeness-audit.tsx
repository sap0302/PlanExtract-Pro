"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { runCompletenessAudit, type AuditFlag } from "@/lib/completeness-audit";

interface CompletenessAuditProps {
  items: Array<{
    name: string;
    system: string;
    measurementType: string;
    quantity: number;
  }>;
}

const severityStyles: Record<string, { bg: string; border: string; icon: string }> = {
  error: { bg: "bg-red-50", border: "border-red-200", icon: "🔴" },
  warning: { bg: "bg-amber-50", border: "border-amber-200", icon: "🟡" },
  info: { bg: "bg-blue-50", border: "border-blue-200", icon: "🔵" },
};

export function CompletenessAudit({ items }: CompletenessAuditProps) {
  const flags = useMemo(() => runCompletenessAudit(items), [items]);

  if (flags.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-green-700">
            ✅ Completeness Check Passed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No obvious missing items detected. Manual review still recommended.
          </p>
        </CardContent>
      </Card>
    );
  }

  const errors = flags.filter((f) => f.severity === "error");
  const warnings = flags.filter((f) => f.severity === "warning");
  const infos = flags.filter((f) => f.severity === "info");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Completeness Audit
          <span className="ml-2 font-normal text-muted-foreground">
            {errors.length > 0 && (
              <span className="text-red-600">{errors.length} issue{errors.length > 1 ? "s" : ""}</span>
            )}
            {errors.length > 0 && warnings.length > 0 && " · "}
            {warnings.length > 0 && (
              <span className="text-amber-600">{warnings.length} warning{warnings.length > 1 ? "s" : ""}</span>
            )}
            {(errors.length > 0 || warnings.length > 0) && infos.length > 0 && " · "}
            {infos.length > 0 && (
              <span className="text-blue-600">{infos.length} suggestion{infos.length > 1 ? "s" : ""}</span>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {flags.map((flag, idx) => (
          <FlagRow key={idx} flag={flag} />
        ))}
      </CardContent>
    </Card>
  );
}

function FlagRow({ flag }: { flag: AuditFlag }) {
  const style = severityStyles[flag.severity] || severityStyles.info;

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 rounded-md text-sm ${style.bg} ${style.border} border`}
    >
      <span className="shrink-0 mt-0.5">{style.icon}</span>
      <div className="flex-1 min-w-0">
        <span className="font-medium text-xs uppercase text-muted-foreground">
          {flag.category}
        </span>
        <p className="mt-0.5">{flag.message}</p>
        {flag.missingItem && (
          <p className="mt-1 text-xs text-muted-foreground">
            Suggested: <code className="bg-white/50 px-1 rounded">{flag.missingItem}</code>
            {flag.missingType && ` (${flag.missingType})`}
          </p>
        )}
      </div>
    </div>
  );
}
