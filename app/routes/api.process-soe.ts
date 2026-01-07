import { json, type ActionFunctionArgs } from "@remix-run/cloudflare";
// eslint-disable-next-line import/no-unresolved
// @ts-ignore - temporary until pdf-lib is installed in dependencies
import { PDFDocument } from "pdf-lib";

// Module-scope helpers
function nowIso() {
  return new Date().toISOString();
}
function truncate(str: string, max = 400) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max)}…(${str.length} chars)` : str;
}
function summarizeArray(arr: unknown[], maxItems = 20) {
  if (!Array.isArray(arr)) return String(arr);
  return arr.length > maxItems
    ? `${arr.slice(0, maxItems).join(", ")}…(+${arr.length - maxItems} more)`
    : arr.join(", ");
}
function logInfo(message: string, meta?: unknown) {
  if (meta === undefined)
    console.log(`[process-soe][INFO] ${nowIso()} ${message}`);
  else console.log(`[process-soe][INFO] ${nowIso()} ${message}`, meta);
}
function logWarn(message: string, meta?: unknown) {
  if (meta === undefined)
    console.warn(`[process-soe][WARN] ${nowIso()} ${message}`);
  else console.warn(`[process-soe][WARN] ${nowIso()} ${message}`, meta);
}
function logError(message: string, meta?: unknown) {
  if (meta === undefined)
    console.error(`[process-soe][ERROR] ${nowIso()} ${message}`);
  else console.error(`[process-soe][ERROR] ${nowIso()} ${message}`, meta);
}
function getOpenAIKey(context: unknown): string | undefined {
  return (
    (context as { cloudflare?: { env?: Record<string, string> } })?.cloudflare
      ?.env?.OPENAI_API_KEY ?? undefined
  );
}

async function uploadToOpenAIFiles(pdf: File, apiKey: string): Promise<string> {
  console.log("in uploadToOpenAIFiles function");
  const uploadForm = new FormData();
  uploadForm.append("file", pdf, pdf.name || "input.pdf");
  uploadForm.append("purpose", "assistants");
  const resp = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: uploadForm,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI files.create failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { id: string };
  return data.id;
}

async function createResponses(apiKey: string, body: unknown): Promise<any> {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI responses.create failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// Extract TSV directly from the original PDF (no pdf-lib needed)
async function extractTsvFromPdfByFileId(
  apiKey: string,
  fileId: string
): Promise<string> {
  const tsvExtractionPrompt = `
You are given a PDF of a clinical trial Schedule of Events table (attached).
Extract the main rectangular table as raw TSV (tab-separated values) with EXACTLY 9 columns per row.
Return ONLY the TSV text with rows separated by newlines. Do NOT add commentary or Markdown.
If the table spans multiple pages, include all rows and do not repeat identical header rows more than once.
`.trim();

  const data: any = await createResponses(apiKey, {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: tsvExtractionPrompt },
          { type: "input_file", file_id: fileId },
        ],
      },
    ],
  });
  const tsv = data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? "";
  if (!tsv || typeof tsv !== "string") {
    throw new Error("TSV extraction failed.");
  }
  return tsv;
}

type SoeRow = {
  row_label: string;
  protocol_section: string;
  screening: string;
  treatment_period_cycle_1_day_1: string;
  treatment_period_cycle_2_day_1: string;
  treatment_period_cycle_1_day_8: string;
  treatment_period_cycle_2_day_8: string;
  treatment_period_cycle_1_day_15: string;
  treatment_period_cycle_2_day_15: string;
  c3_and_beyond: string;
  eot: string;
  follow_up_every_12_weeks_up_to_3_years_from_eot: string;
};

const SOE_HEADERS: (keyof SoeRow)[] = [
  "row_label",
  "protocol_section",
  "screening",
  "treatment_period_cycle_1_day_1",
  "treatment_period_cycle_2_day_1",
  "treatment_period_cycle_1_day_8",
  "treatment_period_cycle_2_day_8",
  "treatment_period_cycle_1_day_15",
  "treatment_period_cycle_2_day_15",
  "c3_and_beyond",
  "eot",
  "follow_up_every_12_weeks_up_to_3_years_from_eot",
];

type RunFlags = {
  includeSoePdf: boolean;
  runUpload: boolean;
  runDetect: boolean;
  runReduce: boolean;
  runTsv: boolean;
  runJson: boolean;
};

function parseRunFlags(url: URL, formData: FormData): RunFlags {
  const on = (key: string) =>
    (formData.get(key) as string | null) === "1" ||
    url.searchParams.get(key) === "1";
  return {
    includeSoePdf: on("includeSoePdf"),
    runUpload: on("runUpload"),
    runDetect: on("runDetect"),
    runReduce: on("runReduce"),
    runTsv: on("runTsv"),
    runJson: on("runJson"),
  };
}
async function convertTsvToFixedJson(
  apiKey: string,
  tsv: string
): Promise<SoeRow[]> {
  const prompt2 = `
You are given a TSV representation of a clinical trial Schedule of Events
table extracted with a PDF table-detection tool.

The TSV has:
- multiple header rows at the top
- possibly repeated header rows (because the table spans multiple pages)
- a rectangular grid of data rows below the headers
- 9 columns in every row

You must convert this TSV into a JSON array using a FIXED column schema.
You must NOT invent or change any field names.

TSV:
${tsv}

===============================================
IMPORTANT: DO NOT INFER NAMES FROM HEADERS
===============================================

- You may use the header rows ONLY to decide which rows are headers.
- You MUST NOT use the header text to construct or modify JSON key names.
- All JSON keys are FIXED and are given below.
- Use ONLY the exact key names specified. Do not shorten, expand,
  or add prefixes/suffixes.

===============================================
HEADER ROWS vs DATA ROWS
===============================================

Treat a row as a HEADER ROW if:
- It appears before the first row where column 1 (protocol section)
  contains a real protocol section number (e.g., "8.3.1", "11.3", "5"), OR
- It exactly matches a previous header row (because headers are repeated
  when the table spans multiple pages).

Ignore all HEADER ROWS when producing output.
Use only DATA ROWS (rows after the header block) in the JSON array.

===============================================
FIXED JSON SCHEMA (USE EXACTLY THESE KEYS)
===============================================

For every DATA row you must produce one JSON object with EXACTLY these keys:

- "row_label"
- "protocol_section"
- "screening"
- "treatment_period_cycle_1_day_1"
- "treatment_period_cycle_2_day_1"
- "treatment_period_cycle_1_day_8"
- "treatment_period_cycle_2_day_8"
- "treatment_period_cycle_1_day_15"
- "treatment_period_cycle_2_day_15"
- "c3_and_beyond"
- "eot"
- "follow_up_every_12_weeks_up_to_3_years_from_eot"

Do NOT invent any additional keys.
Do NOT change these names.
Do NOT omit any of these keys.

===============================================
TSV COLUMN → JSON FIELD MAPPING
===============================================

Each TSV row has 9 columns, indexed 0 through 8.
For every DATA row, map them as follows:

- Column 0 → "row_label"
- Column 1 → "protocol_section"
- Column 2 → "screening"

- Column 3 applies to BOTH Cycle 1 and Cycle 2, Day 1:
    * Read the value from TSV column 3.
    * Put that value into BOTH:
        "treatment_period_cycle_1_day_1"
        "treatment_period_cycle_2_day_1"

- Column 4 applies to BOTH Cycle 1 and Cycle 2, Day 8:
    * Read the value from TSV column 4.
    * Put that value into BOTH:
        "treatment_period_cycle_1_day_8"
        "treatment_period_cycle_2_day_8"

- Column 5 applies to BOTH Cycle 1 and Cycle 2, Day 15:
    * Read the value from TSV column 5.
    * Put that value into BOTH:
        "treatment_period_cycle_1_day_15"
        "treatment_period_cycle_2_day_15"

- Column 6 → "c3_and_beyond"
- Column 7 → "eot"
- Column 8 → "follow_up_every_12_weeks_up_to_3_years_from_eot"

Under no circumstances should you create any other mapping or any other keys.

===============================================
RECTANGULAR OUTPUT
===============================================

- Every JSON row object must contain ALL keys listed in the fixed schema.
- If a value is blank, include the key with value "" (do not omit keys).

===============================================
OUTPUT FORMAT
===============================================

Output a single JSON array of row objects.
Return ONLY valid JSON. No comments, no explanations, no markdown.
`.trim();

  const data: any = await createResponses(apiKey, {
    model: "gpt-4.1-mini",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt2 }] }],
  });
  const rawJson =
    data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? "";
  if (!rawJson || typeof rawJson !== "string") {
    throw new Error("JSON conversion failed.");
  }
  const rows = JSON.parse(rawJson) as SoeRow[];
  return rows;
}

function rowsToCsv(rows: SoeRow[]): string {
  const esc = (s: string) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const headerLine = SOE_HEADERS.join(",");
  const lines = rows.map((r) =>
    SOE_HEADERS.map((h) => esc(r[h] ?? "")).join(",")
  );
  return [headerLine, ...lines].join("\n");
}

function logTableColumns(rows: SoeRow[], maxRows: number = 5) {
  if (!rows || rows.length === 0) {
    console.log("tableData empty");
    return;
  }
  const n = Math.min(rows.length, maxRows);
  console.log(`tableData by column (showing ${n} rows):`);
  for (const h of SOE_HEADERS) {
    const sample = [];
    for (let i = 0; i < n; i++) {
      sample.push(`${i}: ${rows[i][h] ?? ""}`);
    }
    console.log(h, sample);
  }
}

// ---------- Scheduling helpers (computed dates row) ----------
type ScheduleDates = {
  protocol_section: string;
  screening: string;
  treatment_period_cycle_1_day_1: string;
  treatment_period_cycle_2_day_1: string;
  treatment_period_cycle_1_day_8: string;
  treatment_period_cycle_2_day_8: string;
  treatment_period_cycle_1_day_15: string;
  treatment_period_cycle_2_day_15: string;
  c3_and_beyond: string;
  eot: string;
};

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Assumptions:
// - screening: today + 1 day
// - C1D1: screening + 7 days
// - C1D8: C1D1 + 7 days
// - C1D15: C1D1 + 14 days
// - C2D1: C1D15 + 30 days
// - C2D8: C2D1 + 7 days
// - C2D15: C2D1 + 14 days
// - C3+ beyond: C2D15 + 30 days
// - EOT: C3+ beyond + 30 days
function computeScheduleDates(today: Date = new Date()): ScheduleDates {
  const screening = addDays(today, 1);
  const c1d1 = addDays(screening, 7);
  const c1d8 = addDays(c1d1, 7);
  const c1d15 = addDays(c1d1, 14);
  const c2d1 = addDays(c1d15, 30);
  const c2d8 = addDays(c2d1, 7);
  const c2d15 = addDays(c2d1, 14);
  const c3Beyond = addDays(c2d15, 30);
  const eot = addDays(c3Beyond, 30);
  return {
    protocol_section: "",
    screening: formatIsoDate(screening),
    treatment_period_cycle_1_day_1: formatIsoDate(c1d1),
    treatment_period_cycle_2_day_1: formatIsoDate(c2d1),
    treatment_period_cycle_1_day_8: formatIsoDate(c1d8),
    treatment_period_cycle_2_day_8: formatIsoDate(c2d8),
    treatment_period_cycle_1_day_15: formatIsoDate(c1d15),
    treatment_period_cycle_2_day_15: formatIsoDate(c2d15),
    c3_and_beyond: formatIsoDate(c3Beyond),
    eot: formatIsoDate(eot),
  };
}

// Build a CSV for display that:
// - Drops 'follow_up_every_12_weeks_up_to_3_years_from_eot'
// - Adds a synthetic "dates" row using the above schedule
function buildDisplayCsv(rows: SoeRow[], schedule: ScheduleDates): string {
  const displayHeaders: (keyof SoeRow)[] = [
    "row_label",
    "protocol_section",
    "screening",
    // Group all Cycle 1 visits together
    "treatment_period_cycle_1_day_1",
    "treatment_period_cycle_1_day_8",
    "treatment_period_cycle_1_day_15",
    // Then group all Cycle 2 visits together
    "treatment_period_cycle_2_day_1",
    "treatment_period_cycle_2_day_8",
    "treatment_period_cycle_2_day_15",
    "c3_and_beyond",
    "eot",
  ];
  const esc = (s: string) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  // Use human-friendly label for the first column header
  const headerLine = ["Trial Task", ...displayHeaders.slice(1)].join(",");
  const datesRow = [
    "dates",
    schedule.protocol_section,
    schedule.screening,
    // Cycle 1 dates (in grouped order)
    schedule.treatment_period_cycle_1_day_1,
    schedule.treatment_period_cycle_1_day_8,
    schedule.treatment_period_cycle_1_day_15,
    // Cycle 2 dates (in grouped order)
    schedule.treatment_period_cycle_2_day_1,
    schedule.treatment_period_cycle_2_day_8,
    schedule.treatment_period_cycle_2_day_15,
    schedule.c3_and_beyond,
    schedule.eot,
  ]
    .map(esc)
    .join(",");
  const dataLines = rows.map((r) =>
    displayHeaders.map((h) => esc((r as any)[h] ?? "")).join(",")
  );
  return [headerLine, datesRow, ...dataLines].join("\n");
}

async function detectSoePages(
  params: { file?: File; fileId?: string },
  apiKey: string
): Promise<{ fileId: string; raw: string; pdfIndices: number[] }> {
  const fileId =
    params.fileId ??
    (params.file ? await uploadToOpenAIFiles(params.file, apiKey) : undefined);
  if (!fileId) throw new Error("detectSoePages requires a file or fileId.");

  const prompt = `
You are given a multi-page PDF (attached). Your task is to find the
0-based page indices where the actual Schedule of Events TABLE appears.
Instructions:
1. Examine EVERY page of the attached PDF in order (from index 0 to the end).
2. A valid Schedule of Events TABLE page MUST contain ALL of these:
   - A large rectangular grid with many rows and columns.
   - Column headers such as: "Protocol Section", "Screening",
     "Treatment Period", "Follow-up Period", "Day (D)".
   - Procedure names in the first column (e.g. "Informed consent",
     "Medical/Cancer history", "Physical examination").
   - Cells containing "X" marks and/or timing text.
3. The table may span multiple pages. If any part of the grid appears
   on a page, include that page index.
4. IGNORE pages where "Schedule of Events" is only mentioned in text,
   such as table-of-contents or references.
5. Use 0-based indexing (first PDF page = 0). Do NOT use printed page
   numbers if they differ from the file sequence.
Return ONLY strict JSON:
{"pdf_indices": [LIST_OF_0_BASED_PAGE_INDICES]}
`.trim();

  const data: any = await createResponses(apiKey, {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_file", file_id: fileId },
        ],
      },
    ],
  });
  const raw = data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? "";
  logInfo("detectSoePages raw preview", truncate(raw, 500));
  if (!raw || typeof raw !== "string") {
    throw new Error("Missing text output from Responses API.");
  }
  let pdfIndices: number[] = [];
  try {
    const parsed = JSON.parse(raw);
    pdfIndices = Array.isArray(parsed?.pdf_indices) ? parsed.pdf_indices : [];
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      pdfIndices = Array.isArray(parsed?.pdf_indices) ? parsed.pdf_indices : [];
    }
  }
  if (!pdfIndices.length)
    throw new Error("No indices parsed from model output");
  logInfo("detectSoePages indices", {
    fileId,
    count: pdfIndices.length,
    indices: summarizeArray(pdfIndices as unknown as unknown[], 30),
  });
  return { fileId, raw, pdfIndices };
}

// Build an SOE-only PDF (containing only detected pages) from the original File
async function buildSoeOnlyPdfFile(
  originalPdfFile: File,
  pdfIndices: number[]
): Promise<File> {
  const srcBytes = await originalPdfFile.arrayBuffer();
  const srcDoc = await PDFDocument.load(srcBytes);
  const dstDoc = await PDFDocument.create();
  const pages = await dstDoc.copyPages(srcDoc, pdfIndices);
  for (const p of pages) dstDoc.addPage(p);
  const soeBytes = await dstDoc.save();
  const soeBlob = new Blob([soeBytes], { type: "application/pdf" });
  return new File([soeBlob], "soe_only.pdf", { type: "application/pdf" });
}

export const action = async ({ request, context }: ActionFunctionArgs) => {
  logInfo("action start");
  const url = new URL(request.url);
  const stepParam = url.searchParams.get("step");
  const formData = await request.formData();
  const file = formData.get("file");
  const step = (formData.get("step") as string | null) ?? stepParam ?? "mock";
  const { includeSoePdf, runUpload, runDetect, runReduce, runTsv, runJson } =
    parseRunFlags(url, formData);
  logInfo("request params", {
    step,
    includeSoePdf,
    hasFile: file instanceof File,
    runUpload,
    runDetect,
    runReduce,
    runTsv,
    runJson,
  });

  // Build response pieces (visits will be computed; mock removed)
  {
    // const visits = [ ...mock removed... ];
    const visits: Array<{ date: string; label?: string; events: string[] }> =
      [];
    let fileId: string | undefined;
    let uploadError: string | undefined;
    let pdfIndices: number[] | undefined;
    let detectRaw: string | undefined;
    let detectError: string | undefined;
    let tsv: string | undefined;
    let tableData: SoeRow[] | undefined;
    let csv: string | undefined;
    let csvDisplay: string | undefined;
    let soeFileId: string | undefined;
    let soePdfBase64: string | undefined;
    let soeFileName: string | undefined;
    try {
      const anyRun = runUpload || runDetect || runReduce || runTsv || runJson;
      if (file instanceof File && anyRun) {
        const apiKey = getOpenAIKey(context);
        if (!apiKey) {
          uploadError = "Missing OPENAI_API_KEY";
          logWarn(uploadError);
        } else {
          // Ensure upload happens if any subsequent step needs it
          try {
            fileId = await uploadToOpenAIFiles(file, apiKey);
          } catch (err) {
            uploadError = `${err}`;
            logError("upload failed", uploadError);
          }
          // Detect pages (optional)
          if (fileId && runDetect) {
            try {
              const detected = await detectSoePages(
                { fileId, file: undefined },
                apiKey
              );
              pdfIndices = detected.pdfIndices;
              detectRaw = detected.raw;
            } catch (err) {
              detectError = `${err}`;
              logWarn("detectSoePages failed", detectError);
            }
          }
          // Build SOE-only PDF (optional, requires indices)
          if (fileId && runReduce && pdfIndices && pdfIndices.length > 0) {
            try {
              const soeFile = await buildSoeOnlyPdfFile(file, pdfIndices);
              if (includeSoePdf) {
                soePdfBase64 = await fileToBase64(soeFile);
                soeFileName = soeFile.name;
              }
              soeFileId = await uploadToOpenAIFiles(soeFile, apiKey);
            } catch (err) {
              detectError = detectError ?? `${err}`;
              logWarn("SOE-only PDF build/upload failed", detectError);
            }
          }
          // Extract TSV (optional)
          if (runTsv) {
            try {
              const targetFileId = soeFileId || fileId;
              if (targetFileId) {
                tsv = await extractTsvFromPdfByFileId(apiKey, targetFileId);
              }
            } catch (err) {
              detectError = detectError ?? `${err}`;
              logWarn("TSV extraction failed", detectError);
            }
          }
          // Convert TSV to JSON/CSV (optional)
          if (runJson && tsv) {
            try {
              tableData = await convertTsvToFixedJson(apiKey, tsv);
              // Build both raw CSV (all columns) and display CSV (dates row, drop follow-up)
              csv = rowsToCsv(tableData);
              const schedule = computeScheduleDates(new Date());
              csvDisplay = buildDisplayCsv(tableData, schedule);
              logTableColumns(tableData, 15);
              // Compute "visits" from schedule + tableData columns
              const columnPlan: Array<{
                key: keyof ScheduleDates;
                label: string;
              }> = [
                { key: "screening", label: "Screening" },
                { key: "treatment_period_cycle_1_day_1", label: "C1D1" },
                { key: "treatment_period_cycle_1_day_8", label: "C1D8" },
                { key: "treatment_period_cycle_1_day_15", label: "C1D15" },
                { key: "treatment_period_cycle_2_day_1", label: "C2D1" },
                { key: "treatment_period_cycle_2_day_8", label: "C2D8" },
                { key: "treatment_period_cycle_2_day_15", label: "C2D15" },
                { key: "c3_and_beyond", label: "C3+ and beyond" },
                { key: "eot", label: "EOT" },
              ];
              const dateFor = (k: keyof ScheduleDates) =>
                (schedule as any)[k] as string;
              for (const col of columnPlan) {
                const dateStr = dateFor(col.key);
                if (!dateStr) continue;
                const eventsForColumn: string[] = (tableData ?? [])
                  .filter((r) => {
                    const v = (r as any)[col.key] as string | undefined;
                    return v !== undefined && String(v).trim() !== "";
                  })
                  .map((r) => r.row_label);
                visits.push({
                  date: dateStr,
                  label: col.label,
                  events: eventsForColumn,
                });
              }
              // Sort visits by date asc
              visits.sort((a, b) => a.date.localeCompare(b.date));
            } catch (err) {
              detectError = detectError ?? `${err}`;
              logWarn("TSV→JSON conversion failed", detectError);
            }
          }
        }
      } else if (!file) {
        uploadError = "No file provided";
        logWarn(uploadError);
      }
    } catch (e) {
      uploadError = `${e}`;
      logError("unexpected error during processing", uploadError);
    }
    return json({
      visits,
      fileId,
      uploadError,
      pdfIndices,
      detectRaw,
      detectError,
      tsv,
      tableData,
      csv,
      csv_display: csvDisplay ?? undefined,
      soeFileId,
      soePdfBase64,
      soeFileName,
    });
  }
};

export const loader = async () => {
  return json({ error: "Method Not Allowed" }, { status: 405 });
};
