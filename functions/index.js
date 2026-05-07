const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

admin.initializeApp();

const logger = functions.logger;

const asInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

// Hard limits to avoid wasting resources per submission
const BATCH_ENTRY_TIMEOUT_MS = asInt(process.env.BATCH_ENTRY_TIMEOUT_MS, 60_000);
const PDF_FETCH_TIMEOUT_MS = asInt(process.env.PDF_FETCH_TIMEOUT_MS, 20_000);
const GEMINI_TIMEOUT_MS = asInt(process.env.GEMINI_TIMEOUT_MS, 35_000);
// Parallelism: how many batch submissions may process concurrently (across instances).
// This is the primary knob to speed up batches while controlling Gemini load.
const BATCH_MAX_INSTANCES = asInt(process.env.BATCH_MAX_INSTANCES, 10);
// Sweeper: how long we allow a doc to remain in `processing` before force-failing it.
// Keep slightly above BATCH_ENTRY_TIMEOUT_MS to cover function teardown / retries.
const PROCESSING_STUCK_AFTER_MS = asInt(
  process.env.PROCESSING_STUCK_AFTER_MS,
  Math.max(BATCH_ENTRY_TIMEOUT_MS + 15_000, 90_000)
);

// Retention: auto-delete uploaded PDFs after N ms (keep DB entry).
const PDF_RETENTION_MS = asInt(process.env.PDF_RETENTION_MS, 24 * 60 * 60 * 1000); // default 24h

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = async (label, ms, fn) => {
  const timeoutErr = new Error(`${label} timed out after ${ms}ms`);
  timeoutErr.code = "TIMEOUT";
  return await Promise.race([
    (async () => await fn())(),
    (async () => {
      await sleep(ms);
      throw timeoutErr;
    })(),
  ]);
};

const fmtMs = (ms) => `${Math.max(0, Math.round(ms))}ms`;

const logLine = (level, submissionId, step, detail, meta = {}) => {
  const prefix = `[batch][${submissionId}] ${step}`;
  const msg = detail ? `${prefix} - ${detail}` : prefix;
  logger[level](msg, { submissionId, step, ...meta });
};

exports.extractRc = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const { base64Data, base64Image, mimeType, customPrompt } = req.body || {};
    const payloadData = base64Data || base64Image;
    const payloadMimeType = mimeType || "image/jpeg";

    if (!payloadData) {
      res.status(400).send("Missing file payload");
      return;
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    const prompt = `
      You are a highly accurate OCR and data extraction system for Vehicle Registration Certificates (RC).
      Analyze the provided image and extract all relevant vehicle information for a pre-printed form.
      Return a JSON object with the following keys. If a value is missing, return an empty string.

      Keys:
      regnNo, regdOwner, swdOf, manufacturingDt, regnDate, regdValidity, 
      colour, fuel, vehicleClass, bodyType, manufacturer, chassisNo, 
      engineNo, modelNo, hypothecatedTo, unladenWt, cubicCapacity, 
      wheelBase, rlw, seatCapacity, standCapacity, noOfCyc, ownerSerial, 
      address, issuingAuthority, purpose.
      
      CRITICAL: 
      1. Return ONLY the JSON object. No other text.
      2. Dates: Use DD-MM-YYYY for regnDate and for regdValidity when the value is a calendar date (not "As per Fitness"). For manufacturingDt only, output MM/YYYY always: two-digit month (01–12), four-digit year, slash separator (e.g. 08/2024). Normalize from whatever appears on the RC (e.g. 8/2024 → 08/2024).
      3. Names: Extract EXACTLY as written.
      4. Numbers: Extract Chassis/Engine numbers in full. For cubicCapacity, use digits only with no CC/cc suffix; when the RC shows a decimal capacity, preserve that exact decimal as printed — never round it to an integer.
      5. Do not use weight units like kg; include only the numeric value. For **rlw** always use the **laden** weight from the RC only (Registered Laden Weight, R.L.W., "Laden", or the column that is explicitly laden / gross laden — never unladen, kerb, or empty weight). For **unladenWt** use the unladen weight only. Never swap or duplicate these values.
      6. In address, include "HR " (with a space) just before the pincode.
      7. Use temporary address, not permanent address, when both are present.
      8. Do not include any commas in address.
      9. For ownerSerial, always return two-digit format with leading zero when single digit (1 => 01, 2 => 02, ...).
      10. issuingAuthority and regdValidity — output these fields in final form in JSON. The web app will not rewrite them (only trims whitespace).
          - issuingAuthority: Always output exactly PREFIX then one space then LOCATION. if nothing is in the pdf just before the location then output "SDM" then one space then the location. otherwise output the exact text that is in the pdf just before the location . for example if the text is "RTA KHARKHONDA" then output "RTA KHARKHONDA" otherwise output "SDM" then one space then the location.
          - regdValidity: If issuingAuthority is RTA-type (starts with RTA and a place), set exactly to "As per Fitness". Otherwise set to Fitness valid upto from the document in DD-MM-YYYY (labels may read "Fitness valid upto" or "Fitness valid updo").
      11. hypothecatedTo: Extract **only** the bank or financier **name** (e.g. "HDFC BANK", "STATE BANK OF INDIA"). Omit branch addresses, loan/account numbers, legal boilerplate, the words "Hypothecated to", hyphens used as filler, and anything that is not the institution name. **Maximum 30 characters** total — abbreviate intelligently if needed so the string never exceeds 30 characters. Single line, no newlines. If there is no hypothecation, return "".
      12. vehicleClass: Strip all parenthetical parts including the parentheses themselves (remove whatever appears inside (...)). Example: "MOTOR CAB (LVP)" → "Motor Cab". Title-case the remaining class text when the source is all caps.

      Additional Rules:
      ${customPrompt || "None"}
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: {
        parts: [
          { inlineData: { data: payloadData, mimeType: payloadMimeType } },
          { text: prompt }
        ]
      },
      config: { 
        responseMimeType: "application/json"
      }
    });

    const text = response.text;
    const extractedData = JSON.parse(text || '{}');
    
    res.json(extractedData);
  } catch (error) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.processBatchSubmission = functions
  .runWith({
    // Each Firestore background invocation processes exactly one submission.
    // Allow multiple instances so many PDFs can be processed in parallel.
    // (In the emulator this may still appear limited, but in production this controls parallelism.)
    maxInstances: BATCH_MAX_INSTANCES,
    timeoutSeconds: Math.ceil(Math.max(BATCH_ENTRY_TIMEOUT_MS, GEMINI_TIMEOUT_MS, PDF_FETCH_TIMEOUT_MS) / 1000) + 10,
  })
  .firestore
  .document('batchSubmissions/{submissionId}')
  .onCreate(async (snap, context) => {
    const submissionId = context.params.submissionId;
    const submission = snap.data();

    if (submission.status !== 'pending') {
      return null;
    }

    try {
      const startedAt = Date.now();
      logLine(
        "info",
        submissionId,
        "start",
        `file="${submission.fileName}" userId="${submission.userId || ""}" batchJobId="${submission.batchJobId || ""}"`,
        { fileName: submission.fileName, userId: submission.userId || null, batchJobId: submission.batchJobId || null }
      );

      // Lease: prevents "forever processing" if function crashes mid-flight.
      // Sweeper will mark as error after lease expires.
      await snap.ref.update({
        status: 'processing',
        processingStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // Firestore serverTimestamp can't add durations, so store a numeric deadline too.
      // We still keep leaseExpiresAt for querying/sweeper readability.
      await snap.ref.update({
        leaseExpiresAtMs: Date.now() + PROCESSING_STUCK_AFTER_MS,
      });

      const result = await withTimeout("batch_entry", BATCH_ENTRY_TIMEOUT_MS, async () => {
        const t0 = Date.now();

        const pdfUrl = submission.pdfUrl;
        if (!pdfUrl) throw new Error("Missing pdfUrl on submission");

        logLine("info", submissionId, "pdf_fetch:start", `timeout=${PDF_FETCH_TIMEOUT_MS}ms`, {
          pdfFetchTimeoutMs: PDF_FETCH_TIMEOUT_MS,
        });
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);
        let response;
        try {
          response = await fetch(pdfUrl, { signal: controller.signal });
        } finally {
          clearTimeout(fetchTimer);
        }
        if (!response.ok) {
          throw new Error(`PDF fetch failed: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const pdfBytes = arrayBuffer.byteLength || 0;
        logLine(
          "info",
          submissionId,
          "pdf_fetch:done",
          `bytes=${pdfBytes} dur=${fmtMs(Date.now() - t0)}`,
          { pdfBytes, fetchMs: Date.now() - t0 }
        );

        const base64Data = Buffer.from(arrayBuffer).toString('base64');

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const prompt = `
        You are a highly accurate OCR and data extraction system for Vehicle Registration Certificates (RC).
        Analyze the provided PDF and extract all relevant vehicle information.
        Return a JSON object with the following keys. If a value is missing, return an empty string.

        Keys:
        regnNo, regdOwner, swdOf, manufacturingDt, regnDate, regdValidity, 
        colour, fuel, vehicleClass, bodyType, manufacturer, chassisNo, 
        engineNo, modelNo, hypothecatedTo, unladenWt, cubicCapacity, 
        wheelBase, rlw, seatCapacity, standCapacity, noOfCyc, ownerSerial, 
        address, issuingAuthority, purpose.
        
        CRITICAL: 
        1. Return ONLY the JSON object. No other text.
        2. Dates: Use DD-MM-YYYY for regnDate and for regdValidity when the value is a calendar date (not "As per Fitness"). For manufacturingDt only, output MM/YYYY always: two-digit month (01–12), four-digit year, slash separator (e.g. 08/2024).
        3. Names: Extract EXACTLY as written.
        4. Numbers: Extract Chassis/Engine numbers in full. For cubicCapacity, preserve exact decimal as printed.
        5. Do not use weight units like kg; include only the numeric value.
        6. For ownerSerial, always return two-digit format with leading zero when single digit (1 => 01, 2 => 02, ...).
        7. hypothecatedTo: Extract only the bank/financier name. Maximum 30 characters. Single line, no newlines.
        8. vehicleClass: Strip all parenthetical parts. Title-case when source is all caps.
      `;

        logLine(
          "info",
          submissionId,
          "gemini:start",
          `model=gemini-2.5-flash-lite timeout=${GEMINI_TIMEOUT_MS}ms`,
          { model: "gemini-2.5-flash-lite", geminiTimeoutMs: GEMINI_TIMEOUT_MS }
        );
        const t1 = Date.now();
        const extractionResponse = await withTimeout("gemini_generateContent", GEMINI_TIMEOUT_MS, async () => {
          return await ai.models.generateContent({
            model: "gemini-2.5-flash-lite",
            contents: {
              parts: [
                { inlineData: { data: base64Data, mimeType: 'application/pdf' } },
                { text: prompt }
              ]
            },
            config: {
              responseMimeType: "application/json"
            }
          });
        });
        logLine(
          "info",
          submissionId,
          "gemini:done",
          `dur=${fmtMs(Date.now() - t1)}`,
          { geminiMs: Date.now() - t1 }
        );

        const extractedData = JSON.parse(extractionResponse.text || '{}');
        return { extractedData, pdfBytes, totalMs: Date.now() - t0 };
      });

      await snap.ref.update({
        status: 'processed',
        extractedData: result.extractedData,
        processedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: null,
        leaseExpiresAtMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (submission.batchJobId) {
        const batchJobRef = getFirestore().collection('batchJobs').doc(submission.batchJobId);
        await batchJobRef.update({
          processedFiles: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      logLine(
        "info",
        submissionId,
        "success",
        `file="${submission.fileName}" bytes=${result.pdfBytes} total=${fmtMs(Date.now() - startedAt)}`,
        { fileName: submission.fileName, pdfBytes: result.pdfBytes, totalMs: Date.now() - startedAt }
      );
    } catch (error) {
      const message = error?.message || "Unknown extraction error";
      const code = error?.code || null;
      logLine(
        "error",
        submissionId,
        "error",
        `${code ? `${code}: ` : ""}${message}`,
        { fileName: submission?.fileName, code, message, stack: error?.stack }
      );
      
      await snap.ref.update({
        status: 'error',
        errorMessage: code ? `${code}: ${message}` : message,
        errorCode: code || null,
        failedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: null,
        leaseExpiresAtMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return null;
  });

// Background sweeper to ensure nothing stays "processing" forever.
// Runs periodically and force-fails expired leases.
exports.sweepStuckBatchSubmissions = functions.pubsub
  .schedule("every 5 minutes")
  .onRun(async () => {
    const nowMs = Date.now();
    const db = getFirestore();
    const qSnap = await db
      .collection("batchSubmissions")
      .where("status", "==", "processing")
      .where("leaseExpiresAtMs", "<=", nowMs)
      .limit(100)
      .get();

    if (qSnap.empty) {
      logger.debug("[batch][sweeper] no stuck submissions", { nowMs });
      return null;
    }

    logger.warn("[batch][sweeper] found stuck submissions", { count: qSnap.size, nowMs });

    const batch = db.batch();
    for (const docSnap of qSnap.docs) {
      batch.update(docSnap.ref, {
        status: "error",
        errorCode: "TIMEOUT",
        errorMessage: `TIMEOUT: processing exceeded ${PROCESSING_STUCK_AFTER_MS}ms`,
        failedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: null,
        leaseExpiresAtMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    return null;
  });

// Background cleanup: delete old uploaded PDFs from Storage after retention window.
// Keeps the Firestore entry intact so users can still edit extracted data.
exports.cleanupOldBatchPdfs = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - PDF_RETENTION_MS;
    const db = getFirestore();

    // Only cleanup entries that still reference a PDF.
    // We prefer storagePath, but can fall back to parsed URLs if needed.
    const snap = await db
      .collection("batchSubmissions")
      .where("createdAt", "<=", new Date(cutoffMs))
      .limit(100)
      .get();

    if (snap.empty) {
      logger.debug("[batch][cleanup] no old submissions", { cutoffMs, retentionMs: PDF_RETENTION_MS });
      return null;
    }

    const bucket = admin.storage().bucket();
    let deleted = 0;
    let skipped = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      if (data.pdfDeletedAt) {
        skipped++;
        continue;
      }

      const storagePath =
        data.storagePath ||
        (() => {
          const url = data.pdfUrl;
          if (typeof url !== "string") return null;
          const idx = url.indexOf("/o/");
          if (idx === -1) return null;
          const encoded = url.slice(idx + 3).split("?")[0];
          if (!encoded) return null;
          try {
            return decodeURIComponent(encoded);
          } catch {
            return encoded;
          }
        })();

      if (!storagePath || typeof storagePath !== "string") {
        skipped++;
        continue;
      }

      try {
        await bucket.file(storagePath).delete({ ignoreNotFound: true });
        await docSnap.ref.update({
          pdfDeletedAt: FieldValue.serverTimestamp(),
          pdfUrl: null,
          storagePath: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        deleted++;
      } catch (e) {
        // Don't fail the whole cleanup job; just log.
        logger.warn("[batch][cleanup] failed to delete pdf", {
          submissionId: docSnap.id,
          storagePath,
          message: e?.message,
        });
      }
    }

    logger.info("[batch][cleanup] done", { deleted, skipped, retentionMs: PDF_RETENTION_MS });
    return null;
  });
