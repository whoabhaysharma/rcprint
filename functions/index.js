const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const Razorpay = require("razorpay");
const crypto = require("crypto");

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

const allowCors = (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
};

/**
 * Use the Gemini Developer API with an API key only.
 * If GEMINI_API_KEY is missing, @google/genai may use Application Default Credentials (emulator / gcloud)
 * and hit generativelanguage.googleapis.com with an OAuth token that lacks scopes →
 * 403 PERMISSION_DENIED / ACCESS_TOKEN_SCOPE_INSUFFICIENT.
 */
const createGenaiClient = () => {
  const apiKey = requireEnv("GEMINI_API_KEY");
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
  });
};

const requireAuth = async (req) => {
  const header = req.get("authorization") || req.get("Authorization") || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error("Missing Authorization bearer token");
    err.code = 401;
    throw err;
  }
  const token = match[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded?.uid) throw new Error("Invalid token");
    return decoded;
  } catch (e) {
    const err = new Error("Invalid Authorization bearer token");
    err.code = 401;
    throw err;
  }
};

// Credit packs offered. Keyed by INR amount.
// 100 INR -> 100 credits (entry pack); 299 INR -> 350 credits (value pack).
// AI extraction (each batch file, etc.) costs AI_PROCESSING_CREDIT_COST
// credits on success only (see deductAiCreditsOrThrow). Manual PDF workflows do not
// hit these endpoints and are free on the client.
const PLANS = {
  100: { amountInr: 100, credits: 100 },
  299: { amountInr: 299, credits: 350 },
};

const getUserRef = (uid) => getFirestore().collection("users").doc(uid);

/** Credits charged only after a successful AI extraction. Not charged on failure. Manual entry uses no AI and is free on the client. */
const AI_PROCESSING_CREDIT_COST = asInt(process.env.AI_PROCESSING_CREDIT_COST, 2);

const deductAiCreditsOrThrow = async (uid, ledgerMeta = {}) => {
  if (!uid || typeof uid !== "string") {
    const err = new Error("Missing user id for billing");
    err.code = "BAD_USER";
    throw err;
  }
  const db = getFirestore();
  const userRef = getUserRef(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const cur = Number(snap.data()?.credits ?? 0);
    if (!Number.isFinite(cur) || cur < AI_PROCESSING_CREDIT_COST) {
      const err = new Error(
        `Insufficient credits for AI processing (need ${AI_PROCESSING_CREDIT_COST}, have ${Number.isFinite(cur) ? cur : 0})`
      );
      err.code = "INSUFFICIENT_CREDITS";
      throw err;
    }
    const nextBal = cur - AI_PROCESSING_CREDIT_COST;
    tx.set(
      userRef,
      { credits: nextBal, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    const ledgerRef = userRef.collection("creditLedger").doc();
    const source = ledgerMeta.source || "ai_extraction";
    const label =
      source === "batch_ai"
        ? "Batch AI — PDF extraction"
        : source === "extractRc"
          ? "AI extraction"
          : "AI processing";
    tx.set(ledgerRef, {
      createdAt: FieldValue.serverTimestamp(),
      delta: -AI_PROCESSING_CREDIT_COST,
      balanceAfter: nextBal,
      type: "ai_extraction",
      label,
      meta: ledgerMeta && typeof ledgerMeta === "object" ? ledgerMeta : {},
    });
  });
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
    const auth = await requireAuth(req);
    const { base64Data, base64Image, mimeType, customPrompt } = req.body || {};
    const payloadData = base64Data || base64Image;
    const payloadMimeType = mimeType || "image/jpeg";

    if (!payloadData) {
      res.status(400).send("Missing file payload");
      return;
    }

    const ai = createGenaiClient();
    
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

    await deductAiCreditsOrThrow(auth.uid, { source: "extractRc" });

    res.json(extractedData);
  } catch (error) {
    const code = Number(error?.code);
    if (code === 401) {
      res.status(401).json({ error: error.message || "Unauthorized" });
      return;
    }
    if (error?.code === "INSUFFICIENT_CREDITS") {
      res.status(402).json({
        error: "INSUFFICIENT_CREDITS",
        message: error.message || "Insufficient credits for AI processing",
        creditsRequired: AI_PROCESSING_CREDIT_COST,
      });
      return;
    }
    console.error("Extraction error:", error);
    res.status(500).json({ error: error.message });
  }
});

exports.createRazorpayOrder = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const auth = await requireAuth(req);
    const keyId = requireEnv("RAZORPAY_KEY_ID");
    const keySecret = requireEnv("RAZORPAY_KEY_SECRET");

    const { planInr, currency = "INR", notes } = req.body || {};
    const planKey = Number(planInr);
    const plan = PLANS[planKey];
    if (!plan) {
      res.status(400).json({ error: "Invalid planInr. Allowed: 100, 299" });
      return;
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    // Razorpay: receipt must be unique and max 40 chars (Firebase UID + timestamp exceeds that).
    const receipt = `c_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const order = await razorpay.orders.create({
      amount: plan.amountInr * 100,
      currency,
      receipt,
      notes: {
        ...(notes && typeof notes === "object" ? notes : {}),
        uid: auth.uid,
        planInr: String(plan.amountInr),
        credits: String(plan.credits),
      },
    });

    await getFirestore()
      .collection("razorpayOrders")
      .doc(order.id)
      .set({
        uid: auth.uid,
        planInr: plan.amountInr,
        credits: plan.credits,
        status: "created",
        receipt: order.receipt || receipt,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

    res.json({ order, keyId });
  } catch (error) {
    const msg = error?.message || String(error);
    logger.error(`[razorpay] createOrder error: ${msg}`, { stack: error?.stack });
    const status = Number(error?.code) === 401 ? 401 : 500;
    res.status(status).json({ error: msg || "Failed to create order" });
  }
});

exports.verifyRazorpayPayment = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const auth = await requireAuth(req);
    const keySecret = requireEnv("RAZORPAY_KEY_SECRET");
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ ok: false, error: "Missing Razorpay fields" });
      return;
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac("sha256", keySecret).update(payload).digest("hex");
    const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)));

    if (!ok) {
      res.status(400).json({ ok: false, error: "Invalid signature" });
      return;
    }

    const db = getFirestore();
    const orderRef = db.collection("razorpayOrders").doc(String(razorpay_order_id));
    const userRef = getUserRef(auth.uid);

    const result = await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error("Unknown order");
      const orderData = orderSnap.data() || {};
      if (orderData.uid !== auth.uid) {
        const err = new Error("Order does not belong to user");
        err.code = 403;
        throw err;
      }
      if (orderData.status === "credited") {
        const userSnap = await tx.get(userRef);
        const credits = Number(userSnap.data()?.credits || 0);
        return { alreadyCredited: true, credits };
      }

      const creditsToAdd = Number(orderData.credits || 0);
      if (!Number.isFinite(creditsToAdd) || creditsToAdd <= 0) throw new Error("Invalid order credits");

      const userSnap = await tx.get(userRef);
      const currentCredits = Number(userSnap.data()?.credits || 0);
      const nextCredits = currentCredits + creditsToAdd;
      tx.set(userRef, { credits: nextCredits, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      const ledgerRef = userRef.collection("creditLedger").doc();
      tx.set(ledgerRef, {
        createdAt: FieldValue.serverTimestamp(),
        delta: creditsToAdd,
        balanceAfter: nextCredits,
        type: "purchase",
        label: `Purchase — +${creditsToAdd} credits`,
        meta: {
          orderId: String(razorpay_order_id),
          paymentId: String(razorpay_payment_id),
          planInr: orderData.planInr,
        },
      });

      tx.set(
        orderRef,
        {
          status: "credited",
          razorpay_payment_id: String(razorpay_payment_id),
          creditedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { alreadyCredited: false, credits: nextCredits };
    });

    res.json({ ok: true, credits: result.credits, alreadyCredited: result.alreadyCredited });
  } catch (error) {
    logger.error("[razorpay] verifyPayment error", { message: error?.message, stack: error?.stack });
    const status = Number(error?.code) === 401 ? 401 : Number(error?.code) === 403 ? 403 : 500;
    res.status(status).json({ ok: false, error: error?.message || "Failed to verify payment" });
  }
});

exports.getMyCredits = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    const snap = await getUserRef(auth.uid).get();
    const credits = Number(snap.data()?.credits || 0);
    res.json({ credits: Number.isFinite(credits) ? credits : 0 });
  } catch (error) {
    const status = Number(error?.code) === 401 ? 401 : 500;
    res.status(status).json({ error: error?.message || "Failed to get credits" });
  }
});

exports.getCreditHistory = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    const limitRaw = Number(req.query?.limit);
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 12));
    const startAfterId = req.query?.startAfter ? String(req.query.startAfter) : "";

    const db = getFirestore();
    const col = getUserRef(auth.uid).collection("creditLedger");
    let q = col.orderBy("createdAt", "desc").limit(limit + 1);
    if (startAfterId) {
      const cursorDoc = await col.doc(startAfterId).get();
      if (cursorDoc.exists) {
        q = col.orderBy("createdAt", "desc").startAfter(cursorDoc).limit(limit + 1);
      }
    }

    const snap = await q.get();
    const docs = snap.docs;
    const hasMore = docs.length > limit;
    const pageDocs = hasMore ? docs.slice(0, limit) : docs;

    const items = pageDocs.map((d) => {
      const data = d.data() || {};
      const createdAtMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : null;
      return {
        id: d.id,
        createdAtMs,
        delta: Number(data.delta),
        balanceAfter: Number(data.balanceAfter),
        type: data.type || null,
        label: data.label || "",
        meta: data.meta && typeof data.meta === "object" ? data.meta : {},
      };
    });

    const nextCursor = hasMore && pageDocs.length ? pageDocs[pageDocs.length - 1].id : null;

    res.json({ items, nextCursor });
  } catch (error) {
    const status = Number(error?.code) === 401 ? 401 : 500;
    logger.error("[credits] history error", { message: error?.message });
    res.status(status).json({ error: error?.message || "Failed to load credit history" });
  }
});

exports.consumeCredits = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    const { cost } = req.body || {};
    const nCost = Number(cost);
    if (!Number.isFinite(nCost) || nCost <= 0) {
      res.status(400).json({ ok: false, error: "Invalid cost" });
      return;
    }
    const db = getFirestore();
    const userRef = getUserRef(auth.uid);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const current = Number(snap.data()?.credits || 0);
      if (!Number.isFinite(current) || current < nCost) {
        return { ok: false, credits: Number.isFinite(current) ? current : 0 };
      }
      const next = current - nCost;
      tx.set(userRef, { credits: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      const ledgerRef = userRef.collection("creditLedger").doc();
      tx.set(ledgerRef, {
        createdAt: FieldValue.serverTimestamp(),
        delta: -nCost,
        balanceAfter: next,
        type: "consume",
        label: `Used ${nCost} credits`,
        meta: {},
      });
      return { ok: true, credits: next };
    });
    res.json(result);
  } catch (error) {
    const status = Number(error?.code) === 401 ? 401 : 500;
    res.status(status).json({ ok: false, error: error?.message || "Failed to consume credits" });
  }
});

const batchSubmissionRuntimeOpts = {
  maxInstances: BATCH_MAX_INSTANCES,
  timeoutSeconds: Math.ceil(Math.max(BATCH_ENTRY_TIMEOUT_MS, GEMINI_TIMEOUT_MS, PDF_FETCH_TIMEOUT_MS) / 1000) + 10,
};

/**
 * Shared batch PDF → Gemini → deduct credits → mark processed.
 * Used by onCreate (new uploads) and onUpdate (retry after error / stuck processing).
 */
async function runBatchSubmissionWorker(snap, submissionId) {
  const submission = snap.data();
  if (!submission || submission.status !== "pending") {
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

        const ai = createGenaiClient();

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

      const batchUid = String(submission.userId || "").trim();
      if (!batchUid) {
        throw new Error("Missing userId on submission (required for AI billing)");
      }
      try {
        await deductAiCreditsOrThrow(batchUid, { source: "batch_ai", batchSubmissionId: submissionId });
        const balSnap = await getUserRef(batchUid).get();
        const remaining = Number(balSnap.data()?.credits ?? 0);
        logLine(
          "info",
          submissionId,
          "billing",
          `deducted=${AI_PROCESSING_CREDIT_COST} balance=${Number.isFinite(remaining) ? remaining : "?"}`,
          { uid: batchUid, remaining }
        );
      } catch (deductErr) {
        if (deductErr?.code === "INSUFFICIENT_CREDITS") {
          await snap.ref.update({
            status: "error",
            errorCode: "INSUFFICIENT_CREDITS",
            errorMessage:
              deductErr.message ||
              `Insufficient credits for AI processing (need ${AI_PROCESSING_CREDIT_COST} per file)`,
            failedAt: FieldValue.serverTimestamp(),
            leaseExpiresAt: null,
            leaseExpiresAtMs: null,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return null;
        }
        throw deductErr;
      }

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
}

exports.processBatchSubmission = functions
  .runWith(batchSubmissionRuntimeOpts)
  .firestore.document("batchSubmissions/{submissionId}")
  .onCreate(async (snap, context) => runBatchSubmissionWorker(snap, context.params.submissionId));

/** Retries reset status to `pending` via updateDoc — onCreate does not run; this handles re-processing + billing. */
exports.processBatchSubmissionRetry = functions
  .runWith(batchSubmissionRuntimeOpts)
  .firestore.document("batchSubmissions/{submissionId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    if (!after || after.status !== "pending") return null;
    if (!before) return null;
    if (before.status === "pending") return null;
    if (before.status !== "error" && before.status !== "processing") return null;
    return runBatchSubmissionWorker(change.after, context.params.submissionId);
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
