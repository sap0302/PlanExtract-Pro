import type { Extraction, Item } from "@prisma/client";

type ExtractionWithItems = Omit<Extraction, "pdfData"> & {
  pdfData?: Buffer | null;
  items: Item[];
};

const systemLabels: Record<string, string> = {
  water: "Water",
  storm_drain: "Storm Drain",
  wastewater: "Wastewater",
  other: "Other",
};

const systemOrder = ["water", "storm_drain", "wastewater", "other"];

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildRow(values: (string | number | null | undefined)[]): string {
  return values.map(escapeCsv).join(",");
}

function sortBySystem(items: Item[]): Item[] {
  return [...items].sort(
    (a, b) => systemOrder.indexOf(a.system) - systemOrder.indexOf(b.system)
  );
}

function formatQty(item: Item): string {
  return item.measurementType === "count"
    ? item.quantity.toFixed(0)
    : item.quantity.toFixed(2);
}

export function generateInventoryCSV(
  extraction: ExtractionWithItems
): string {
  const lines: string[] = [];

  // Header info
  lines.push(`Project: ${escapeCsv(extraction.name)}`);
  lines.push(`Source File: ${escapeCsv(extraction.fileName)}`);
  lines.push("");

  const headers = buildRow([
    "Item Name",
    "System",
    "Quantity",
    "Unit",
    "Sheet",
    "Method",
    "Demo",
    "Cost Each",
    "Markup %",
    "Price Each",
    "Price Total",
    "Evidence",
    "Node Range",
    "Station Range",
    "Notes",
  ]);

  const areaItems = sortBySystem(
    extraction.items.filter((i) => i.measurementType === "area")
  );
  const countItems = sortBySystem(
    extraction.items.filter((i) => i.measurementType === "count")
  );
  const linearItems = sortBySystem(
    extraction.items.filter((i) => i.measurementType === "linear")
  );

  // Area Items
  if (areaItems.length > 0) {
    lines.push("--- AREA ITEMS (SQ FT) ---");
    lines.push(headers);
    let totalQty = 0;
    let totalPrice = 0;
    areaItems.forEach((item) => {
      totalQty += item.quantity;
      totalPrice += item.priceTotal;
      lines.push(
        buildRow([
          item.name,
          systemLabels[item.system] || item.system,
          formatQty(item),
          item.unit,
          item.sourceSheetId,
          item.quantityMethod,
          item.isDemo ? "Y" : "N",
          item.costEach.toFixed(2),
          item.markupPercent.toFixed(1),
          item.priceEach.toFixed(2),
          item.priceTotal.toFixed(2),
          item.evidence,
          item.nodeRange,
          item.stationRange,
          item.description,
        ])
      );
    });
    lines.push(
      buildRow([
        "SUBTOTAL",
        "",
        totalQty.toFixed(2),
        "SQ FT",
        "",
        "",
        "",
        "",
        "",
        "",
        totalPrice.toFixed(2),
        "",
        "",
        "",
        "",
      ])
    );
    lines.push("");
  }

  // Count Items
  if (countItems.length > 0) {
    lines.push("--- COUNT ITEMS (EA) ---");
    lines.push(headers);
    let totalQty = 0;
    let totalPrice = 0;
    countItems.forEach((item) => {
      totalQty += item.quantity;
      totalPrice += item.priceTotal;
      lines.push(
        buildRow([
          item.name,
          systemLabels[item.system] || item.system,
          formatQty(item),
          item.unit,
          item.sourceSheetId,
          item.quantityMethod,
          item.isDemo ? "Y" : "N",
          item.costEach.toFixed(2),
          item.markupPercent.toFixed(1),
          item.priceEach.toFixed(2),
          item.priceTotal.toFixed(2),
          item.evidence,
          item.nodeRange,
          item.stationRange,
          item.description,
        ])
      );
    });
    lines.push(
      buildRow([
        "SUBTOTAL",
        "",
        totalQty.toFixed(0),
        "EA",
        "",
        "",
        "",
        "",
        "",
        "",
        totalPrice.toFixed(2),
        "",
        "",
        "",
        "",
      ])
    );
    lines.push("");
  }

  // Linear Items
  if (linearItems.length > 0) {
    lines.push("--- LINEAR ITEMS (FT) ---");
    lines.push(headers);
    let totalQty = 0;
    let totalPrice = 0;
    linearItems.forEach((item) => {
      totalQty += item.quantity;
      totalPrice += item.priceTotal;
      lines.push(
        buildRow([
          item.name,
          systemLabels[item.system] || item.system,
          formatQty(item),
          item.unit,
          item.sourceSheetId,
          item.quantityMethod,
          item.isDemo ? "Y" : "N",
          item.costEach.toFixed(2),
          item.markupPercent.toFixed(1),
          item.priceEach.toFixed(2),
          item.priceTotal.toFixed(2),
          item.evidence,
          item.nodeRange,
          item.stationRange,
          item.description,
        ])
      );
    });
    lines.push(
      buildRow([
        "SUBTOTAL",
        "",
        totalQty.toFixed(2),
        "FT",
        "",
        "",
        "",
        "",
        "",
        "",
        totalPrice.toFixed(2),
        "",
        "",
        "",
        "",
      ])
    );
    lines.push("");
  }

  // Grand total
  const grandTotal = extraction.items.reduce(
    (sum, item) => sum + item.priceTotal,
    0
  );
  lines.push(
    buildRow([
      "GRAND TOTAL",
      "",
      String(extraction.items.length) + " items",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      grandTotal.toFixed(2),
      "",
      "",
      "",
      "",
    ])
  );

  return lines.join("\n");
}
