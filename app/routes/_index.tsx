import type { MetaFunction } from "@remix-run/cloudflare";
import type React from "react";
import { useEffect, useState } from "react";

type VisitEvent = {
  date: string;
  events: string[];
  label?: string;
};

export const meta: MetaFunction = () => {
  return [
    { title: "Clinical Trial Scheduler" },
    {
      name: "description",
      content: "Upload SOE and manage patient visit appointments",
    },
  ];
};

export default function Index() {
  const [file, setFile] = useState<File | null>(null);
  const [visits, setVisits] = useState<VisitEvent[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedTimes, setSelectedTimes] = useState<Record<string, string>>(
    {}
  );
  const [csv, setCsv] = useState<string>("");
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const [availableSlots, setAvailableSlots] = useState<
    Record<string, string[]>
  >({});

  // Build a Google Calendar template URL (no OAuth required).
  const buildGCalTemplateUrl = (args: {
    title: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:mm (local)
    durationMinutes?: number;
    details?: string;
    location?: string;
  }) => {
    const {
      title,
      date,
      time,
      durationMinutes = 60,
      details = "",
      location = "",
    } = args;
    const startLocal = new Date(`${date}T${time}:00`);
    const endLocal = new Date(startLocal);
    endLocal.setMinutes(endLocal.getMinutes() + durationMinutes);
    const toStamp = (d: Date) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(
        2,
        "0"
      )}${String(d.getUTCDate()).padStart(2, "0")}T${String(
        d.getUTCHours()
      ).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(
        d.getUTCSeconds()
      ).padStart(2, "0")}Z`;
    const start = toStamp(startLocal);
    const end = toStamp(endLocal);
    const u = new URL("https://calendar.google.com/calendar/render");
    u.searchParams.set("action", "TEMPLATE");
    u.searchParams.set("text", title);
    u.searchParams.set("dates", `${start}/${end}`);
    if (details) u.searchParams.set("details", details);
    if (location) u.searchParams.set("location", location);
    return u.toString();
  };

  // Check Google connection once on mount to avoid "Connect" loop UX
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/calendar/status");
        if (res.ok) {
          const data = (await res.json()) as { connected: boolean };
          setConnected(!!data.connected);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const handleClear = () => {
    setFile(null);
    setVisits([]);
    setCsv("");
    setCsvRows([]);
    setSelectedTimes({});
    setAvailableSlots({});
  };

  // Minimal CSV parser that supports quoted fields and commas within quotes
  const parseCsv = (text: string): string[][] => {
    if (!text) return [];
    const rows: string[][] = [];
    let current: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];
      if (inQuotes) {
        if (char === '"' && next === '"') {
          cell += '"';
          i++; // skip escaped quote
        } else if (char === '"') {
          inQuotes = false;
        } else {
          cell += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ",") {
          current.push(cell);
          cell = "";
        } else if (char === "\n" || char === "\r") {
          // Handle CRLF and LF
          if (char === "\r" && next === "\n") {
            i++;
          }
          current.push(cell);
          rows.push(current);
          current = [];
          cell = "";
        } else {
          cell += char;
        }
      }
    }
    // Push last cell/row if any
    if (cell.length > 0 || inQuotes || current.length > 0) {
      current.push(cell);
      rows.push(current);
    }
    return rows;
  };

  // 9:00 - 17:00 in 30m intervals
  const timeSlots = Array.from({ length: 17 }, (_, i) => {
    const hour = Math.floor(i / 2) + 9;
    const minute = i % 2 === 0 ? "00" : "30";
    return `${hour.toString().padStart(2, "0")}:${minute}`;
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleProcessFile = async () => {
    if (!file) return;
    setIsProcessing(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        "/api/process-soe?runUpload=1&runDetect=1&runReduce=1&runTsv=1&runJson=1",
        {
          method: "POST",
          body: form,
        }
      );
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const data = (await res.json()) as {
        visits: VisitEvent[];
        csv?: string;
        csv_display?: string;
      };
      setVisits(data.visits || []);
      const csvText = data.csv_display || data.csv || "";
      setCsv(csvText);
      setCsvRows(parseCsv(csvText));
      // Fetch Google free slots if connected
      try {
        const status = await fetch("/api/calendar/status").then(
          (r) => r.json() as Promise<{ connected: boolean }>
        );
        setConnected(!!status.connected);
        if (status.connected) {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
          const results: Record<string, string[]> = {};
          for (const v of data.visits || []) {
            const resp = await fetch("/api/calendar/free", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                date: v.date,
                timeZone: tz,
                workStart: "09:00",
                workEnd: "17:00",
                slotMinutes: 30,
              }),
            });
            if (resp.ok) {
              const { slots } = (await resp.json()) as { slots: string[] };
              results[v.date] = slots;
            }
          }
          setAvailableSlots(results);
        }
      } catch {
        setConnected(false);
      }
    } catch (_err) {
      // Fallback to local mock on error
      const mockData: VisitEvent[] = [
        {
          date: "2025-01-12",
          events: ["Blood Test", "Vital Signs", "Drug Administration"],
        },
      ];
      setVisits(mockData);
      setCsv("");
      setCsvRows([]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleScheduleVisit = async (
    visit: VisitEvent & { label?: string }
  ) => {
    const date = visit.date;
    const time = selectedTimes[date];
    if (!time) {
      alert("Please select a time for this visit");
      return;
    }
    // Open Google Calendar template directly (no OAuth), avoiding loop
    const title = (visit as any).label
      ? `Visit - ${(visit as any).label}`
      : "Clinical Trial Visit";
    const details =
      visit.events && visit.events.length > 0
        ? `Clinical events to perform:\n- ${visit.events.join("\n- ")}`
        : "Scheduled via Clinical Trial Scheduler";
    const url = buildGCalTemplateUrl({
      title,
      date,
      time,
      durationMinutes: 60,
      details,
    });
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-4xl px-4 py-12">
        <div className="mb-10 text-center">
          <h1 className="mb-2 text-4xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
            Clinical Trial Scheduler
          </h1>
          <p className="text-base text-gray-600 dark:text-gray-300">
            Upload Schedule of Events and manage patient visit appointments
          </p>
        </div>

        {/* File Upload Section */}
        <div className="mb-8 rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <div className="border-b border-gray-200 p-6 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
                <UploadIcon className="h-5 w-5" />
                Schedule of Events Upload
              </div>
              {visits.length > 0 && (
                <span className="rounded-full bg-blue-600/10 px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                  {visits.length} visits
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Upload the SOE PDF file to extract visit schedule
            </p>
          </div>
          <div className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label
                  htmlFor="file-upload"
                  className="mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  Select PDF File
                </label>
                <input
                  id="file-upload"
                  type="file"
                  accept=".pdf"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-900 file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-blue-700 dark:text-gray-100"
                />
                {file && (
                  <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                    <span className="font-medium text-gray-800 dark:text-gray-200">
                      {file.name}
                    </span>
                    <span className="ml-2 text-gray-500">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                )}
              </div>
              <div className="flex w-full gap-3 sm:w-auto">
                <button
                  onClick={handleProcessFile}
                  disabled={!file || isProcessing}
                  className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                  type="button"
                >
                  {isProcessing && (
                    <svg
                      className="mr-2 h-4 w-4 animate-spin"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                      />
                    </svg>
                  )}
                  {isProcessing ? "Processing…" : "Process File"}
                </button>
                <button
                  onClick={handleClear}
                  className="inline-flex w-full items-center justify-center rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800 sm:w-auto"
                  type="button"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Visits List */}
        {visits.length > 0 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              Required Patient Visits
            </h2>
            {visits.map((visit, index) => (
              <div
                key={visit.date}
                className="overflow-hidden rounded-lg border border-l-4 border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
                style={{ borderLeftColor: "#2563eb" }}
              >
                <div className="border-b border-gray-200 p-6 dark:border-gray-700">
                  <div className="flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
                    <CalendarIcon className="h-5 w-5 text-blue-600" />
                    {visit.label ? `${visit.label}` : `Visit ${index + 1}`}
                  </div>
                  <p className="mt-1 text-base text-gray-600 dark:text-gray-300">
                    {formatDate(visit.date)}
                  </p>
                </div>
                <div className="space-y-4 p-6">
                  {/* Events List */}
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                      Clinical Events:
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {visit.events.map((event) => (
                        <span
                          key={event}
                          className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/30 dark:text-blue-200"
                        >
                          {event}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Time Selection */}
                  <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-end sm:gap-4">
                    <div className="flex-1">
                      <label
                        htmlFor={`time-${visit.date}`}
                        className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100"
                      >
                        <ClockIcon className="h-4 w-4" />
                        Select Time
                      </label>
                      <select
                        id={`time-${visit.date}`}
                        value={selectedTimes[visit.date] || ""}
                        onChange={(e) =>
                          setSelectedTimes((prev) => ({
                            ...prev,
                            [visit.date]: e.target.value,
                          }))
                        }
                        className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                      >
                        <option value="" disabled>
                          Choose appointment time
                        </option>
                        {(availableSlots[visit.date] &&
                        availableSlots[visit.date].length > 0
                          ? availableSlots[visit.date]
                          : timeSlots
                        ).map((time) => (
                          <option key={time} value={time}>
                            {time}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={() => handleScheduleVisit(visit as any)}
                      className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 sm:w-auto"
                      type="button"
                    >
                      Schedule Visit
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tabular Preview (if we could parse CSV) */}
        {csvRows.length > 0 && (
          <div className="mt-8 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-200 p-4 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Table Preview (parsed CSV)
              </h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                First row is treated as headers. Scroll to view more.
              </p>
            </div>
            <div className="p-4">
              <div className="max-h-96 overflow-auto rounded-md border border-gray-200 dark:border-gray-700">
                <table className="min-w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800">
                    <tr>
                      {csvRows[0].map((h, idx) => (
                        <th
                          key={idx}
                          className="border-b border-gray-200 px-3 py-2 text-left font-semibold text-gray-900 dark:border-gray-700 dark:text-gray-100"
                        >
                          {h || `Column ${idx + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.slice(1).map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className={
                          rIdx % 2 === 0
                            ? "bg-white dark:bg-gray-900"
                            : "bg-gray-50 dark:bg-gray-800/60"
                        }
                      >
                        {row.map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            className="border-b border-gray-200 px-3 py-2 align-top text-gray-800 dark:border-gray-700 dark:text-gray-200"
                          >
                            {cell}
                          </td>
                        ))}
                        {/* Fill missing cells if ragged rows */}
                        {row.length < csvRows[0].length &&
                          Array.from({
                            length: csvRows[0].length - row.length,
                          }).map((_, extraIdx) => (
                            <td
                              key={`extra-${extraIdx}`}
                              className="border-b border-gray-200 px-3 py-2 align-top text-gray-800 dark:border-gray-700 dark:text-gray-200"
                            />
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {visits.length === 0 && !isProcessing && (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-100/50 p-12 text-center dark:border-gray-700 dark:bg-gray-900/50">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center text-gray-500 dark:text-gray-400">
              <CalendarIcon className="h-12 w-12" />
            </div>
            <p className="text-gray-600 dark:text-gray-300">
              Upload and process an SOE file to view visit schedule
            </p>
            {!connected && (
              <>
                <p className="mt-2 text-sm text-gray-500">
                  To auto-schedule directly to Google Calendar, connect once:
                </p>
                <a
                  href="/auth/google"
                  className="mt-4 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Connect Google Calendar
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CalendarIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function UploadIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function ClockIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
