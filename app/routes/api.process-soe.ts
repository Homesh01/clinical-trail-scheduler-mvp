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

  // Always return mock data for now (regardless of step) to allow piece-by-piece testing
  {
    const visits = [
      {
        date: "2025-01-12",
        events: ["Blood Test", "Vital Signs", "Drug Administration"],
      },
      {
        date: "2025-01-19",
        events: ["ECG", "PK Sample"],
      },
      {
        date: "2025-01-26",
        events: ["Blood Test", "Physical Examination", "Drug Administration"],
      },
    ];
    let fileId: string | undefined;
    let uploadError: string | undefined;
    let pdfIndices: number[] | undefined;
    let detectRaw: string | undefined;
    let detectError: string | undefined;
    let tsv: string | undefined;
    let tableData: SoeRow[] | undefined;
    let csv: string | undefined;
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
              csv = rowsToCsv(tableData);
              logTableColumns(tableData, 15);
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
      soeFileId,
      soePdfBase64,
      soeFileName,
    });
  }
};

export const loader = async () => {
  return json({ error: "Method Not Allowed" }, { status: 405 });
};
