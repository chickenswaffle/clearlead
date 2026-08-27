import { Worker } from "node:worker_threads";

export async function extractResumePdf(input, {
  maxBytes = 10 * 1024 * 1024,
  maxPages = 20,
  maxItems = 50_000,
  maxCharacters = 300_000,
  timeoutMs = 7_000,
} = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length === 0) throw new Error("The uploaded PDF is empty.");
  if (buffer.length > maxBytes) throw new Error(`Resume PDF is too large. Use a file under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The uploaded file is not a valid PDF.");

  const data = Uint8Array.from(buffer).buffer;
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./pdf-resume-worker.mjs", import.meta.url), {
      workerData: { data, maxPages, maxItems, maxCharacters },
      transferList: [data],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
      worker.terminate().catch(() => {});
    };
    const timer = setTimeout(() => finish(reject, new Error("PDF processing took too long. Export a simpler text-based PDF or paste the resume text instead.")), timeoutMs);
    worker.once("message", (message) => {
      if (message?.ok) finish(resolve, message.result);
      else finish(reject, new Error(message?.error || "ClearLead could not read this PDF. Export a standard text-based PDF or paste the resume text instead."));
    });
    worker.once("error", () => finish(reject, new Error("ClearLead could not safely process this PDF. Export a standard text-based PDF or paste the resume text instead.")));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(reject, new Error("ClearLead stopped PDF processing to protect the local service. Export a simpler PDF or paste the resume text instead."));
    });
  });
}
