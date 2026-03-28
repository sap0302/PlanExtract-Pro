import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { format } from "date-fns";
import type { Extraction, Item } from "@prisma/client";

type ExtractionWithItems = Omit<Extraction, "rawResponse"> & {
  rawResponse?: string | null;
  items: Item[];
};

const systemLabels: Record<string, string> = {
  water: "Water",
  storm_drain: "Storm Drain",
  wastewater: "Wastewater",
  other: "Other",
};

const systemOrder = ["water", "storm_drain", "wastewater", "other"];

const methodLabels: Record<string, string> = {
  station_math: "Station",
  callout: "Callout",
  schedule: "Schedule",
  count: "Count",
  scale_estimate: "Scale Est.",
};

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

export function generateInventoryPDF(
  extraction: ExtractionWithItems
): Buffer {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Title
  doc.setFontSize(20);
  doc.text("Construction Quantity Takeoff Report", 14, 22);

  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Project: ${extraction.name}`, 14, 32);
  doc.text(`Source File: ${extraction.fileName}`, 14, 38);
  doc.text(
    `Generated: ${format(new Date(), "MMMM d, yyyy 'at' h:mm a")}`,
    14,
    44
  );
  doc.text(
    `Extracted: ${format(extraction.createdAt, "MMMM d, yyyy 'at' h:mm a")}`,
    14,
    50
  );

  // Summary
  if (extraction.summary) {
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text("Project Summary", 14, 62);
    doc.setFontSize(9);
    doc.setTextColor(80);
    const summaryLines = doc.splitTextToSize(
      extraction.summary,
      pageWidth - 28
    );
    doc.text(summaryLines, 14, 69);
  }

  let startY = extraction.summary
    ? 69 +
      doc.splitTextToSize(extraction.summary, pageWidth - 28).length * 5 +
      10
    : 60;

  const tableHead = [
    ["Item Name", "Sheet", "Method", "System", "Qty", "Unit", "Cost Each", "Price Each", "Price Total", "Notes"],
  ];

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
    if (startY > 240) {
      doc.addPage();
      startY = 20;
    }
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(`Area Items (${areaItems.length})`, 14, startY);

    const totalQty = areaItems.reduce((sum, i) => sum + i.quantity, 0);
    const totalPrice = areaItems.reduce((sum, i) => sum + i.priceTotal, 0);

    autoTable(doc, {
      startY: startY + 4,
      head: tableHead,
      body: [
        ...areaItems.map((item) => [
          item.name,
          item.sourceSheetId || "",
          item.quantityMethod ? (methodLabels[item.quantityMethod] || item.quantityMethod) : "",
          systemLabels[item.system] || item.system,
          formatQty(item),
          item.unit,
          `$${item.costEach.toFixed(2)}`,
          `$${item.priceEach.toFixed(2)}`,
          `$${item.priceTotal.toFixed(2)}`,
          item.description || "",
        ]),
        [
          { content: "SUBTOTAL", styles: { fontStyle: "bold" } },
          "",
          "",
          "",
          totalQty.toFixed(2),
          "SQ FT",
          "",
          "",
          `$${totalPrice.toFixed(2)}`,
          "",
        ],
      ],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [41, 128, 185] },
    });
    startY =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 10;
  }

  // Count Items
  if (countItems.length > 0) {
    if (startY > 240) {
      doc.addPage();
      startY = 20;
    }
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(`Count Items (${countItems.length})`, 14, startY);

    const totalQty = countItems.reduce((sum, i) => sum + i.quantity, 0);
    const totalPrice = countItems.reduce((sum, i) => sum + i.priceTotal, 0);

    autoTable(doc, {
      startY: startY + 4,
      head: tableHead,
      body: [
        ...countItems.map((item) => [
          item.name,
          item.sourceSheetId || "",
          item.quantityMethod ? (methodLabels[item.quantityMethod] || item.quantityMethod) : "",
          systemLabels[item.system] || item.system,
          formatQty(item),
          item.unit,
          `$${item.costEach.toFixed(2)}`,
          `$${item.priceEach.toFixed(2)}`,
          `$${item.priceTotal.toFixed(2)}`,
          item.description || "",
        ]),
        [
          { content: "SUBTOTAL", styles: { fontStyle: "bold" } },
          "",
          "",
          "",
          totalQty.toFixed(0),
          "EA",
          "",
          "",
          `$${totalPrice.toFixed(2)}`,
          "",
        ],
      ],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [39, 174, 96] },
    });
    startY =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 10;
  }

  // Linear Items
  if (linearItems.length > 0) {
    if (startY > 240) {
      doc.addPage();
      startY = 20;
    }
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(`Linear Items (${linearItems.length})`, 14, startY);

    const totalQty = linearItems.reduce((sum, i) => sum + i.quantity, 0);
    const totalPrice = linearItems.reduce((sum, i) => sum + i.priceTotal, 0);

    autoTable(doc, {
      startY: startY + 4,
      head: tableHead,
      body: [
        ...linearItems.map((item) => [
          item.name,
          item.sourceSheetId || "",
          item.quantityMethod ? (methodLabels[item.quantityMethod] || item.quantityMethod) : "",
          systemLabels[item.system] || item.system,
          formatQty(item),
          item.unit,
          `$${item.costEach.toFixed(2)}`,
          `$${item.priceEach.toFixed(2)}`,
          `$${item.priceTotal.toFixed(2)}`,
          item.description || "",
        ]),
        [
          { content: "SUBTOTAL", styles: { fontStyle: "bold" } },
          "",
          "",
          "",
          totalQty.toFixed(2),
          "FT",
          "",
          "",
          `$${totalPrice.toFixed(2)}`,
          "",
        ],
      ],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [142, 68, 173] },
    });
    startY =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 10;
  }

  // Grand Total
  const grandTotal = extraction.items.reduce(
    (sum, item) => sum + item.priceTotal,
    0
  );
  if (startY > 260) {
    doc.addPage();
    startY = 20;
  }
  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text(
    `Grand Total: ${extraction.items.length} items | $${grandTotal.toFixed(2)}`,
    14,
    startY
  );

  // Footer on all pages
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `Page ${i} of ${pageCount} - Generated by PlanExtract Pro | \u00A9 Steppe & Stone LLC`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 10,
      { align: "center" }
    );
  }

  return Buffer.from(doc.output("arraybuffer"));
}
