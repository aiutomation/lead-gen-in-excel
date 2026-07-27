// The default table format — the sales team's real "New Site Listing" spreadsheet,
// taken from its `Potential Site` sheet (headers at B15:AD15). The blank merged-cell
// spacer columns (G, N, Z) are skipped, and the sheet's two side-by-side Qty/Tonnage
// pairs are split into "Chiller Set 1/2" so each is a distinct object key.
// The app's own last four columns are appended verbatim.
// The user can rename / add / remove these before generating.
export const DEFAULT_COLUMNS: string[] = [
  // — Potential Site B15:AD15 —
  "File No.", // internal row number — stays N/A on AI generation (the team assigns it)
  "Job Site",
  "State",
  "Area",
  "Code", // internal site code (e.g. PS25-151) — stays N/A on AI generation
  "Address",
  "Type of Building",
  "Storey/Floors",
  "Founded",
  "Area (ft2)",
  "Air Conditioning Area",
  "Chiller System",
  "Chiller Brand",
  "Chiller Set 1 Qty",
  "Chiller Set 1 Tonnage (RT)",
  "Chiller Set 2 Qty",
  "Chiller Set 2 Tonnage (RT)",
  "Total Tonnage (RT)",
  "Recent Renovation / RFQ",
  "Age (Years)",
  "Maintenance Cost Yearly Avg. (MYR)",
  "Change chiller Before",
  "Owner / Group",
  "Contact",
  "Email",
  "PIC / Contact",
  // — appended app columns —
  "Data Availability Notes",
  // Filled by the LinkedIn enrichment step (Enrich toggle) — left "N/A" otherwise.
  "Person In Charge",
  "PIC LinkedIn",
  "Citations",
];

// The default search prompt — the Malaysia chilled-water prospecting context this
// spreadsheet is built for, ready to tweak.
export const DEFAULT_PROMPT =
  "List large commercial buildings and facilities in Malaysia (start with the Klang Valley " +
  "— Kuala Lumpur, Selangor, Petaling Jaya, Subang Jaya) that likely run a central " +
  "chilled-water air-conditioning system — e.g. shopping malls, hotels, office towers, " +
  "private hospitals, universities, factories, and warehouses.";

// A few real rows lifted from the `Potential Site` sheet, used as few-shot examples so
// the research pass matches the team's format and tone (concise Malaysian addresses,
// "N/A" when unknown, tonnage in RT). Kept small on purpose — one line per example.
export const FEW_SHOT_EXAMPLES = [
  {
    "Job Site": "1 Shamelin Shopping Centre",
    State: "Kuala Lumpur",
    Area: "Cheras",
    Address: "100, Jalan 4/91, Taman Shamelin Perkasa, 56100 Kuala Lumpur",
    "Type of Building": "Retail - Mall",
    "Storey/Floors": "3",
    Founded: "1997",
    "Area (ft2)": "400000",
    "Owner / Group": "Y & Y Group",
    Contact: "03-9285 4990",
  },
  {
    "Job Site": "3 Damansara",
    State: "Selangor",
    Area: "Petaling Jaya",
    Address: "3, Jalan SS 20/27, Damansara Intan, 47400 Petaling Jaya, Selangor",
    "Type of Building": "Retail - Mall",
    Founded: "2010",
    "Area (ft2)": "639477",
    "Chiller System": "Water Cooled Screw Chiller",
    "Chiller Brand": "Daikin",
    "Chiller Set 1 Qty": "1",
    "Chiller Set 1 Tonnage (RT)": "500",
    "Total Tonnage (RT)": "500",
    "Owner / Group": "CapitaLand Malaysia Trust (CLMT) REIT",
  },
  {
    "Job Site": "Assunta Hospital",
    State: "Selangor",
    Area: "Petaling Jaya",
    Address: "Jalan Templer, PJS 4, 46990 Petaling Jaya, Selangor",
    "Type of Building": "Hospital (Private)",
    "Storey/Floors": "5",
    Founded: "1954",
    "Air Conditioning Area": "Medical Ward (344 Beds)",
    "Owner / Group": "The Franciscan Missionaries of Mary (FMM)",
    Contact: "03-7872 3000",
    Email: "enquiry@assunta.com.my",
  },
] as const;
