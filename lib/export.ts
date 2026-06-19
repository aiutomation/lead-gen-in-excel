import * as XLSX from "xlsx";
import type { Row } from "./llm"; // type-only: keeps the Gemini SDK out of the client bundle

// Build a worksheet with the columns in the exact order/labels shown on screen.
function toSheet(rows: Row[], columns: string[]) {
  const ordered = rows.map((r) => {
    const o: Record<string, string> = {};
    for (const c of columns) o[c] = r[c] ?? "";
    return o;
  });
  return XLSX.utils.json_to_sheet(ordered, { header: columns });
}

// Robust download: build a real Blob and click an anchor that is attached to the
// DOM (some browsers ignore a click on a detached anchor, which is why the old
// XLSX.writeFile path produced an unreliable/temp download).
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500); // revoke after the download starts
}

export function downloadXLSX(rows: Row[], columns: string[], filename: string): void {
  const ws = toSheet(rows, columns);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leads");
  // Write to an ArrayBuffer (not the virtual FS) -> a real .xlsx Blob.
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(blob, filename);
}

export function downloadCSV(rows: Row[], columns: string[], filename: string): void {
  const csv = XLSX.utils.sheet_to_csv(toSheet(rows, columns));
  // Prepend a UTF-8 BOM so Excel opens accented characters / commas correctly.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}
