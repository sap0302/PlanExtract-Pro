/**
 * Completeness Audit — analyzes extraction results and flags likely missing items.
 * Based on civil engineering connectivity rules and pattern analysis from ground truth comparisons.
 */

export interface AuditFlag {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  missingItem?: string; // Suggested item name to add
  missingSystem?: string;
  missingType?: "area" | "count" | "linear";
}

interface SimpleItem {
  name: string;
  system: string;
  measurementType: string;
  quantity: number;
}

/** Run the completeness audit on extracted items */
export function runCompletenessAudit(items: SimpleItem[]): AuditFlag[] {
  const flags: AuditFlag[] = [];
  const names = items.map((i) => i.name.toUpperCase());
  const systems = new Set(items.map((i) => i.system));

  const hasItem = (pattern: RegExp) => names.some((n) => pattern.test(n));
  const countItems = (pattern: RegExp) =>
    items.filter((i) => pattern.test(i.name.toUpperCase()));
  const hasSystem = (sys: string) => systems.has(sys);

  // === WATER SYSTEM CHECKS ===
  if (hasSystem("water")) {
    // Caps — every dead-end stub needs a cap
    if (!hasItem(/CAP.*W/)) {
      flags.push({
        severity: "warning",
        category: "Water Fittings",
        message:
          "No CAP items found. Every dead-end water pipe stub needs a cap (6\" CAP W, 2\" CAP W, 1\" CAP W). Check all pipe terminations.",
        missingItem: "CAP WATER W",
        missingSystem: "water",
        missingType: "count",
      });
    }

    // Sleeves — road crossings need casing
    if (!hasItem(/SLEEVE.*W/)) {
      flags.push({
        severity: "warning",
        category: "Water Fittings",
        message:
          "No SLEEVE items found. Water pipes crossing roads typically need casing sleeves (12\" SLEEVE WATER W, 8\" SLEEVE WATER W). Check road crossings.",
        missingItem: "SLEEVE WATER W",
        missingSystem: "water",
        missingType: "count",
      });
    }

    // Hydrants should have gate valves
    const hydrants = countItems(/HYDRANT/);
    const gateValves = countItems(/GATE VALVE.*W/);
    if (hydrants.length > 0 && gateValves.length === 0) {
      flags.push({
        severity: "error",
        category: "Water Connectivity",
        message: `Found ${hydrants.reduce((s, i) => s + i.quantity, 0)} fire hydrant(s) but no gate valves. Each hydrant needs at least one gate valve.`,
        missingItem: "GATE VALVE W",
        missingSystem: "water",
        missingType: "count",
      });
    }

    // Saddles should have service lines
    const saddles = countItems(/SADDLE.*W/);
    const serviceLines = countItems(/POLY.*W|COPPER.*W/);
    if (saddles.length > 0 && serviceLines.length === 0) {
      flags.push({
        severity: "warning",
        category: "Water Connectivity",
        message: `Found ${saddles.reduce((s, i) => s + i.quantity, 0)} saddle(s) but no service lines (POLY or COPPER). Each saddle should connect to a service pipe.`,
        missingItem: "POLY W",
        missingSystem: "water",
        missingType: "linear",
      });
    }

    // Fire protection — commercial projects
    if (
      hasItem(/HYDRANT/) &&
      !hasItem(/FDC|FIRE RISER|FIRE VAULT/)
    ) {
      flags.push({
        severity: "info",
        category: "Fire Protection",
        message:
          "No fire protection assemblies found (FDC, fire riser, fire vault). Commercial projects typically have at least one. Check for FDC assemblies near buildings.",
        missingItem: "REMOTE FDC ASSY W",
        missingSystem: "water",
        missingType: "count",
      });
    }
  }

  // === STORM DRAIN CHECKS ===
  if (hasSystem("storm_drain")) {
    // HDPE storm pipe — check if only RCP exists
    const hasRCP = hasItem(/RCP.*SD/);
    const hasHDPE = hasItem(/HDPE.*SD/);
    if (hasRCP && !hasHDPE) {
      flags.push({
        severity: "warning",
        category: "Storm Drain",
        message:
          "Found RCP storm pipe but no HDPE storm pipe. Many projects use HDPE for smaller diameter storm lines (6\"-12\"). Check for HDPE pipe labels on plan views.",
        missingItem: "8\" HDPE SD",
        missingSystem: "storm_drain",
        missingType: "linear",
      });
    }

    // HDPE fittings — if HDPE pipe exists, should have fittings
    if (hasHDPE) {
      if (!hasItem(/90.*HDPE|HDPE.*90/)) {
        flags.push({
          severity: "warning",
          category: "Storm Drain Fittings",
          message:
            "Found HDPE storm pipe but no 90° HDPE bends. Check every direction change in the HDPE system for bend fittings.",
          missingItem: "8\" 90 HDPE SD",
          missingSystem: "storm_drain",
          missingType: "count",
        });
      }
      if (!hasItem(/45.*HDPE|HDPE.*45/)) {
        flags.push({
          severity: "info",
          category: "Storm Drain Fittings",
          message:
            "Found HDPE storm pipe but no 45° HDPE bends. Check for 45° direction changes in the HDPE system.",
          missingItem: "8\" 45 HDPE SD",
          missingSystem: "storm_drain",
          missingType: "count",
        });
      }
      if (!hasItem(/WYE.*HDPE|HDPE.*WYE/)) {
        flags.push({
          severity: "info",
          category: "Storm Drain Fittings",
          message:
            "Found HDPE storm pipe but no WYE HDPE fittings. Check for branch connections in the HDPE system.",
          missingItem: "8X8 WYE HDPE SD",
          missingSystem: "storm_drain",
          missingType: "count",
        });
      }
    }

    // 12" RCP — smallest size, often missed
    if (hasRCP && !hasItem(/12".*RCP|12".*SD/)) {
      flags.push({
        severity: "info",
        category: "Storm Drain",
        message:
          "No 12\" RCP SD found. This is the smallest RCP size and often appears at upstream ends of storm systems. Check for it.",
        missingItem: "12\" RCP SD",
        missingSystem: "storm_drain",
        missingType: "linear",
      });
    }

    // Headwalls/outfalls should have rip rap
    if (hasItem(/HEADWALL|OUTFALL/) && !hasItem(/RIP RAP/)) {
      flags.push({
        severity: "warning",
        category: "Area Items",
        message:
          "Found headwall/outfall structures but no rip rap. Outfalls typically have grouted rip rap areas (20-500 SQ FT). Check plan views near drainage structures.",
        missingItem: "GROUTED RIP RAP",
        missingSystem: "other",
        missingType: "area",
      });
    }
  }

  // === WASTEWATER CHECKS ===
  if (hasSystem("wastewater")) {
    // Cleanouts
    if (!hasItem(/CLEANOUT.*WW/)) {
      flags.push({
        severity: "info",
        category: "Wastewater",
        message:
          "No sewer cleanouts found. Sewer systems typically have cleanouts at direction changes and service connections.",
        missingItem: "CLEANOUT WW",
        missingSystem: "wastewater",
        missingType: "count",
      });
    }
  }

  // === AREA ITEM CHECKS ===
  const concreteItems = countItems(/CONCRETE/);
  if (concreteItems.length === 1 && systems.size > 1) {
    flags.push({
      severity: "warning",
      category: "Area Items",
      message:
        "Only one generic concrete item found. Concrete removal/replacement should be split by utility system (STORM, SEWER, WATER). Each system's trench restoration is a separate line item.",
    });
  }

  if (concreteItems.length > 0) {
    const totalConcrete = concreteItems.reduce((s, i) => s + i.quantity, 0);
    if (totalConcrete > 2000) {
      flags.push({
        severity: "warning",
        category: "Area Items",
        message: `Total concrete area is ${totalConcrete.toFixed(0)} SQ FT. This seems high — verify you're measuring only trench restoration strips (2-4 ft wide), not entire pavement surfaces.`,
      });
    }
  }

  // === GENERAL CHECKS ===
  const totalItems = items.length;
  if (totalItems < 15) {
    flags.push({
      severity: "error",
      category: "Extraction Completeness",
      message: `Only ${totalItems} items extracted. A typical civil utility plan has 25-50+ items. The extraction may have missed entire systems or sheets.`,
    });
  }

  // Check for items with qty=0
  const zeroItems = items.filter(
    (i) => i.quantity === 0 && i.measurementType !== "count"
  );
  if (zeroItems.length > 0) {
    flags.push({
      severity: "error",
      category: "Zero Quantities",
      message: `${zeroItems.length} item(s) have qty=0: ${zeroItems
        .map((i) => i.name)
        .join(", ")}. These should have non-zero quantities from scale measurement.`,
    });
  }

  return flags;
}
