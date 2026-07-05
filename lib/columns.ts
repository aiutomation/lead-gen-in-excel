// The default table format, taken verbatim from the example XLSX (21 cols)
// plus a 22nd "Citations" column fed by Gemini web-grounding source URLs.
// The user can rename / add / remove these before generating.
export const DEFAULT_COLUMNS: string[] = [
  "Building",
  "Address",
  "Type of Building",
  "Type of Business",
  "Operating Hours",
  "Founded/Established Year",
  "Storeys",
  "Number of Shops/Units",
  "Area (ft2)",
  "Last Renovation Year",
  "Last Extension Year",
  "Last Refurbishment Year",
  "Owner",
  "Contact",
  "Manager",
  "Facility Manager",
  "Maintenance Manager",
  "Air-Conditioning Area",
  "Energy Consumption (kWh)",
  "Chiller Type",
  "Data Availability Notes",
  // Filled by the LinkedIn enrichment step (Enrich toggle) — left "N/A" otherwise.
  "Person In Charge",
  "PIC LinkedIn",
  "Citations",
];

// The default search prompt — the user's original request, ready to tweak.
export const DEFAULT_PROMPT =
  "List commercial buildings more than 5 storeys in the Subang Jaya area " +
  "that likely run a chilled-water (central chiller) air-conditioning system " +
  "— e.g. hotels, malls, office towers, hospitals, universities, factories, warehouses.";
