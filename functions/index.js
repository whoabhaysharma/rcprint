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

// Abuse / cost controls for single-shot image extraction (HTTPS).
const EXTRACT_RC_MAX_BASE64_CHARS = asInt(process.env.EXTRACT_RC_MAX_BASE64_CHARS, 14_000_000);
const EXTRACT_RC_RATE_WINDOW_MS = asInt(process.env.EXTRACT_RC_RATE_WINDOW_MS, 60_000);
const EXTRACT_RC_RATE_LIMIT_MAX = asInt(process.env.EXTRACT_RC_RATE_LIMIT_MAX, 24);
// Per-user cap on billable batch AI jobs starting in a window (before Gemini runs).
const BATCH_AI_DEBIT_WINDOW_MS = asInt(process.env.BATCH_AI_DEBIT_WINDOW_MS, 3_600_000);
const BATCH_AI_DEBIT_MAX = asInt(process.env.BATCH_AI_DEBIT_MAX, 200);
const MAX_BATCH_PDF_BYTES = asInt(process.env.MAX_BATCH_PDF_BYTES, 12 * 1024 * 1024);

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

const getRuntimeConfigValue = (name) => {
  // Firebase Functions runtime config (set via `firebase functions:config:set ...`)
  // Docs: https://firebase.google.com/docs/functions/config-env
  const cfg = typeof functions.config === "function" ? functions.config() : {};
  switch (name) {
    case "RAZORPAY_KEY_ID":
      return cfg?.razorpay?.key_id;
    case "RAZORPAY_KEY_SECRET":
      return cfg?.razorpay?.key_secret;
    case "GEMINI_API_KEY":
      return cfg?.gemini?.api_key;
    case "SUPER_ADMIN_EMAIL":
      return cfg?.admin?.super_admin_email;
    default:
      return undefined;
  }
};

const requireEnv = (name) => {
  const value = process.env[name] || getRuntimeConfigValue(name);
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
};

/** Firebase sets this when the Functions emulator is running — use Razorpay test keys only then. */
const useRazorpayTestKeys = () => process.env.FUNCTIONS_EMULATOR === "true";

const getRazorpayKeyId = () => {
  if (useRazorpayTestKeys()) {
    const v = process.env.RAZORPAY_TEST_KEY_ID;
    if (!v) {
      throw new Error(
        "Razorpay (emulator): set RAZORPAY_TEST_KEY_ID and RAZORPAY_TEST_KEY_SECRET in functions/.env — see functions/.env.example"
      );
    }
    return v;
  }
  return requireEnv("RAZORPAY_KEY_ID");
};

const getRazorpayKeySecret = () => {
  if (useRazorpayTestKeys()) {
    const v = process.env.RAZORPAY_TEST_KEY_SECRET;
    if (!v) {
      throw new Error(
        "Razorpay (emulator): set RAZORPAY_TEST_KEY_SECRET in functions/.env — see functions/.env.example"
      );
    }
    return v;
  }
  return requireEnv("RAZORPAY_KEY_SECRET");
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

const getExtractionModel = async () => {
  try {
    const doc = await getFirestore().collection("settings").doc("global").get();
    if (doc.exists) {
      const data = doc.data();
      if (data && data.extractionModel && typeof data.extractionModel === "string" && data.extractionModel.trim() !== "") {
        return data.extractionModel.trim();
      }
    }
  } catch (e) {
    logger.error("Failed to read configured model from Firestore, using default", { message: e?.message });
  }
  return "gemini-3.1-flash-lite";
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

const getUserRef = (uid) => getFirestore().collection("users").doc(uid);

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

/** Email allowed to call claimSuperAdmin and receive `superAdmin: true` on their user doc. */
const getConfiguredSuperAdminEmail = () => {
  const raw = process.env.SUPER_ADMIN_EMAIL;
  if (!raw || !String(raw).trim()) return null;
  return normalizeEmail(raw);
};

const ADMIN_GRANT_MAX_PER_CALL = asInt(process.env.ADMIN_GRANT_MAX_PER_CALL, 50_000);
const ADMIN_DASHBOARD_USERS_LIMIT = asInt(process.env.ADMIN_DASHBOARD_USERS_LIMIT, 500);

/** Public POST /add-credits UI: max credits per request (multiple of 50). */
const PUBLIC_CREDIT_TOPUP_MAX = asInt(process.env.PUBLIC_CREDIT_TOPUP_MAX, 50_000);

/** Set PUBLIC_CREDIT_TOPUP_ENABLED=false or 0 to disable public /add-credits Razorpay order + verify. */
const isPublicCreditTopupEnabled = () => {
  const v = process.env.PUBLIC_CREDIT_TOPUP_ENABLED;
  if (v === undefined || v === "") return true;
  const s = String(v).trim().toLowerCase();
  return s !== "false" && s !== "0" && s !== "no";
};

/** INR charged per credit on the public add-credits page (default 1 → 50 credits = ₹50). */
const getPublicTopupInrPerCredit = () => {
  const n = Number(process.env.PUBLIC_TOPUP_INR_PER_CREDIT ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const isSuperAdminUser = async (uid) => {
  const snap = await getUserRef(uid).get();
  return snap.data()?.superAdmin === true;
};

const hasAnySuperAdmin = async () => {
  const db = getFirestore();
  const snap = await db.collection("users").where("superAdmin", "==", true).limit(1).get();
  return !snap.empty;
};

/** Cost per AI extraction (image or PDF). Debited before Gemini; refunded on failure so users are not charged for failed runs. Manual entry uses no AI and is free on the client. */
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

/**
 * Idempotent rate limit (Firestore-backed). Uses admin SDK — not exposed to clients.
 */
const assertWithinRateLimit = async (uid, key, max, windowMs) => {
  if (!uid || max <= 0 || windowMs <= 0) return;
  const db = getFirestore();
  const ref = db.collection("_rateLimits").doc(`${uid}_${key}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.data() || {};
    let windowStart = Number(data.windowStart) || 0;
    let count = Number(data.count) || 0;
    if (!Number.isFinite(windowStart) || now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    if (count >= max) {
      const err = new Error("Too many AI requests. Please wait and try again.");
      err.code = 429;
      throw err;
    }
    count += 1;
    tx.set(
      ref,
      { windowStart, count, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
};

/** Refund one AI charge (e.g. after Gemini failure). */
const refundAiCredits = async (uid, ledgerMeta = {}) => {
  if (!uid || typeof uid !== "string") return;
  const db = getFirestore();
  const userRef = getUserRef(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const cur = Number(snap.data()?.credits ?? 0);
    const nextBal = cur + AI_PROCESSING_CREDIT_COST;
    tx.set(
      userRef,
      { credits: nextBal, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    const ledgerRef = userRef.collection("creditLedger").doc();
    tx.set(ledgerRef, {
      createdAt: FieldValue.serverTimestamp(),
      delta: AI_PROCESSING_CREDIT_COST,
      balanceAfter: nextBal,
      type: "refund",
      label: ledgerMeta.label || "AI processing refund",
      meta: ledgerMeta && typeof ledgerMeta === "object" ? ledgerMeta : {},
    });
  });
};

/**
 * Debit for batch row before Gemini so unpaid users cannot burn API quota.
 * Skips if this submission was already debited (retry after crash) or already settled.
 */
const debitBatchSubmissionIfNeeded = async (submissionRef, submissionId, uid) => {
  await assertWithinRateLimit(uid, "batchAiDebit", BATCH_AI_DEBIT_MAX, BATCH_AI_DEBIT_WINDOW_MS);
  const db = getFirestore();
  const userRef = getUserRef(uid);
  return await db.runTransaction(async (tx) => {
    const subSnap = await tx.get(submissionRef);
    const sub = subSnap.data() || {};
    if (sub.aiBillingState === "settled") {
      return { didDebit: false, alreadySettled: true };
    }
    if (sub.aiBillingState === "debited") {
      return { didDebit: false, alreadyDebited: true };
    }
    if (sub.status !== "processing") {
      const err = new Error("Batch submission not in processing state");
      err.code = "BAD_STATE";
      throw err;
    }

    const userSnap = await tx.get(userRef);
    const cur = Number(userSnap.data()?.credits ?? 0);
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
    tx.set(ledgerRef, {
      createdAt: FieldValue.serverTimestamp(),
      delta: -AI_PROCESSING_CREDIT_COST,
      balanceAfter: nextBal,
      type: "ai_extraction",
      label: "Batch AI — PDF extraction",
      meta: { source: "batch_ai", batchSubmissionId: submissionId },
    });
    tx.set(
      submissionRef,
      { aiBillingState: "debited", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { didDebit: true };
  });
};

/** Undo batch debit if Gemini / pipeline failed or job timed out in processing. */
const refundBatchAiIfDebited = async (submissionRef, submissionId, uid) => {
  if (!uid || typeof uid !== "string") return;
  const db = getFirestore();
  const userRef = getUserRef(uid);
  try {
    await db.runTransaction(async (tx) => {
      const subSnap = await tx.get(submissionRef);
      if (subSnap.data()?.aiBillingState !== "debited") return;

      const userSnap = await tx.get(userRef);
      const cur = Number(userSnap.data()?.credits ?? 0);
      const nextBal = cur + AI_PROCESSING_CREDIT_COST;
      tx.set(
        userRef,
        { credits: nextBal, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      const ledgerRef = userRef.collection("creditLedger").doc();
      tx.set(ledgerRef, {
        createdAt: FieldValue.serverTimestamp(),
        delta: AI_PROCESSING_CREDIT_COST,
        balanceAfter: nextBal,
        type: "refund",
        label: "Batch AI — refund (failed or timed out)",
        meta: { source: "batch_ai", batchSubmissionId: submissionId },
      });
      tx.set(
        submissionRef,
        { aiBillingState: "none", updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    });
  } catch (e) {
    logger.error("[batch] refund failed", { submissionId, message: e?.message });
  }
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

  let debitedForThisRequest = false;
  let uid = null;
  try {
    const auth = await requireAuth(req);
    uid = auth.uid;
    await assertWithinRateLimit(
      auth.uid,
      "extractRc",
      EXTRACT_RC_RATE_LIMIT_MAX,
      EXTRACT_RC_RATE_WINDOW_MS
    );

    const { base64Data, base64Image, mimeType, customPrompt } = req.body || {};
    const payloadData = base64Data || base64Image;
    const payloadMimeType = mimeType || "image/jpeg";

    if (!payloadData) {
      res.status(400).send("Missing file payload");
      return;
    }

    if (typeof payloadData !== "string" || payloadData.length > EXTRACT_RC_MAX_BASE64_CHARS) {
      res.status(413).json({
        error: "Payload too large",
        maxChars: EXTRACT_RC_MAX_BASE64_CHARS,
      });
      return;
    }

    await deductAiCreditsOrThrow(uid, { source: "extractRc", phase: "pre_ai" });
    debitedForThisRequest = true;

    const ai = createGenaiClient();

    const prompt = `
      You are a highly accurate OCR + data extraction system for Indian Vehicle Registration Certificates (RC).
      Analyze the provided image and extract ONLY the values needed to fill our form.

      OUTPUT REQUIREMENTS
      - Return ONLY a single JSON object. No markdown, no code fences, no explanation.
      - Always return ALL keys listed below. If a value is missing/unclear, return "" (empty string).
      - Never invent values. Prefer "" over guessing.

      REQUIRED JSON KEYS (exact spelling):
      regnNo, regdOwner, swdOf, address, regnDate, manufacturingDt, regdValidity,
      colour, fuel, vehicleClass, bodyType, manufacturer, modelNo,
      chassisNo, engineNo,
      cubicCapacity, wheelBase, unladenWt, rlw,
      seatCapacity, standCapacity, noOfCyc,
      ownerSerial, taxPaidUpTo,
      hypothecatedTo, issuingAuthority, purpose

      WHERE TO FIND EACH KEY IN THE RC (use label anchors; labels may vary in spacing/case):
      - regnNo: use labels "REGISTRATION NO", "Registration Number". Often top section.
      - regdOwner: use "Owner Name" on the top left corner.
      - swdOf: use "Son/wife/daughter of". Extract the person name exactly the same as it is printed.
      - address: use "Full Address: (Temporary)" no commas. add "HR" just before the pincode and format it properly without changing anything
      - regnDate: use "Date of Registration." in the same exact format as it is printed.
      - manufacturingDt: use "Month and Year of Manufacture" use exactly the same format as it is printed. and make sure its MM/YYYY format if the month is one digit add 0 before the month.
      - regdValidity: if issuingAuthority from the top 2nd line is RTA-type (has with "RTA" with the place name), set exactly "As per Fitness". Otherwise use the date "Fitness valid upto" in the bottom of the pdf. Output DD/MM/YYYY.
      - colour: use "Colour" exactly the same as it is printed.
      - fuel: use "Fuel Used in Engine" exactly the same as it is printed.
      - vehicleClass: use "Class of Vehicle" exactly the same as it is printed and remove the part in the parenthesis.
      - bodyType: use "Type Of body" exactly the same as it is printed.
      - manufacturer: use "Maker's Name" exactly the same as it is printed.
      - modelNo: use "Model Name" exactly the same as it is printed.
      - chassisNo: use "Chassis No." exactly the same as it is printed.
      - engineNo: use "Engine No." exactly the same as it is printed.
      - cubicCapacity: use "Cubic Capacity" exactly the same as it is printed.
      - wheelBase: use "Wheel Base" exactly the same as it is printed.
      - unladenWt: use "Unladen Wt " exactly the same as it is printed only the number not the unit.
      - rlw: use "laden Wt" exactly the same as it is printed only the number not the unit.
      - seatCapacity: use "Seating Capacity" exactly the same as it is printed.
      - standCapacity: use "Standing Capacity" exactly the same as it is printed.
      - noOfCyc: use "No. Of Cylinders" exactly the same as it is printed.
      - ownerSerial: use "Owner Sr." exactly the same as it is printed.
      - taxPaidUpTo: if the issuing authority is RTA type then use the value "As per Fitness". otherwise use the date from the pdf "Fitness valid upto" and the format will be DD/MM/YYYY.
      - hypothecatedTo: use "Financer Name" if given otherwise leave it blank.
      - issuingAuthority: if the issuing authority location name has nothing with the location use "SDM" and the location name from the pdf from the top second line other wise if anything 3 character given before the location use that exactly with the location name.
      - purpose: use "Purpose" exactly the same as it is printed or leave it blank if not given.

      Additional Rules (must follow too):
      ${customPrompt || "None"}
    `;

    const activeModel = await getExtractionModel();
    const response = await ai.models.generateContent({
      model: activeModel,
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
    const extractedData = JSON.parse(text || "{}");

    res.json(extractedData);
  } catch (error) {
    if (debitedForThisRequest && uid) {
      try {
        await refundAiCredits(uid, {
          label: "AI extraction refund (processing error)",
          meta: {
            source: "extractRc",
            reason: error?.code || "error",
            message: String(error?.message || "").slice(0, 500),
          },
        });
      } catch (refundErr) {
        logger.error("[extractRc] refund failed", { message: refundErr?.message });
      }
    }
    const code = Number(error?.code);
    if (code === 401) {
      res.status(401).json({ error: error.message || "Unauthorized" });
      return;
    }
    if (code === 429) {
      res.status(429).json({ error: error.message || "Too many requests" });
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
    const keyId = getRazorpayKeyId();
    const keySecret = getRazorpayKeySecret();

    const { amountInr, currency = "INR", notes } = req.body || {};
    const parsedAmount = Number(amountInr);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 50 || parsedAmount > 2000 || parsedAmount % 10 !== 0) {
      res.status(400).json({ error: "Amount must be between ₹50 and ₹2000 in multiples of 10" });
      return;
    }

    const creditsToAdd = parsedAmount;
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    // Razorpay: receipt must be unique and max 40 chars (Firebase UID + timestamp exceeds that).
    const receipt = `c_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const order = await razorpay.orders.create({
      amount: parsedAmount * 100,
      currency,
      receipt,
      notes: {
        ...(notes && typeof notes === "object" ? notes : {}),
        uid: auth.uid,
        planInr: String(parsedAmount),
        credits: String(creditsToAdd),
      },
    });

    await getFirestore()
      .collection("razorpayOrders")
      .doc(order.id)
      .set({
        uid: auth.uid,
        planInr: parsedAmount,
        credits: creditsToAdd,
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
    const keySecret = getRazorpayKeySecret();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ ok: false, error: "Missing Razorpay fields" });
      return;
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac("sha256", keySecret).update(payload).digest("hex");
    const sig = String(razorpay_signature).trim();
    const ok =
      expected.length === sig.length &&
      expected.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"));

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
      if (orderData.publicTopup === true) {
        const err = new Error(
          "This order was created on the public add-credits page — finish verification from that checkout."
        );
        err.code = 400;
        throw err;
      }
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
      tx.set(userRef, { credits: nextCredits, email: auth.email || '', updatedAt: FieldValue.serverTimestamp() }, { merge: true });

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

/**
 * Public /add-credits: create Razorpay order for an existing Auth user (resolved by email).
 * Credits: multiple of 50, min 50. Charge = credits × PUBLIC_TOPUP_INR_PER_CREDIT (default ₹1/credit).
 */
exports.createPublicRazorpayOrder = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  if (!isPublicCreditTopupEnabled()) {
    res.status(403).json({ error: "Public credit purchase is disabled" });
    return;
  }

  try {
    const fwd = req.get("x-forwarded-for");
    const rawIp =
      (fwd && String(fwd).split(",")[0].trim()) ||
      req.ip ||
      req.connection?.remoteAddress ||
      "unknown";
    const ipKey = `pub_rzp_ip_${rawIp}`;
    await assertWithinRateLimit(ipKey, "createPublicRazorpayOrderIp", 60, 3_600_000);

    const keyId = getRazorpayKeyId();
    const keySecret = getRazorpayKeySecret();

    const body = req.body || {};
    const targetEmail = normalizeEmail(body.email);
    const creditsToAdd = Number.parseInt(String(body.credits ?? ""), 10);

    if (!targetEmail || !targetEmail.includes("@")) {
      res.status(400).json({ error: "Enter a valid email address" });
      return;
    }

    await assertWithinRateLimit(`pub_rzp_em_${targetEmail}`, "createPublicRazorpayOrderEmail", 40, 3_600_000);

    if (
      !Number.isFinite(creditsToAdd) ||
      creditsToAdd < 50 ||
      creditsToAdd % 50 !== 0 ||
      creditsToAdd > PUBLIC_CREDIT_TOPUP_MAX
    ) {
      res.status(400).json({
        error: `Credits must be a multiple of 50, at least 50, and at most ${PUBLIC_CREDIT_TOPUP_MAX}`,
      });
      return;
    }

    let targetUser;
    try {
      targetUser = await admin.auth().getUserByEmail(targetEmail);
    } catch (e) {
      if (e?.code === "auth/user-not-found") {
        res.status(404).json({ error: "No account found with that email" });
        return;
      }
      throw e;
    }

    const inrPerCredit = getPublicTopupInrPerCredit();
    const amountInr = creditsToAdd * inrPerCredit;
    const amountPaise = Math.round(amountInr * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
      res.status(400).json({ error: "Invalid payment amount" });
      return;
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const receipt = `p_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: {
        uid: targetUser.uid,
        email: targetEmail,
        credits: String(creditsToAdd),
        amountInr: String(amountInr),
        publicTopup: "true",
      },
    });

    await getFirestore()
      .collection("razorpayOrders")
      .doc(order.id)
      .set({
        uid: targetUser.uid,
        email: targetEmail,
        planInr: amountInr,
        credits: creditsToAdd,
        status: "created",
        receipt: order.receipt || receipt,
        publicTopup: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

    res.json({ order, keyId, credits: creditsToAdd, amountInr });
  } catch (error) {
    const code = Number(error?.code);
    const status = code === 429 ? 429 : 500;
    const msg = error?.message || String(error);
    logger.error(`[razorpay] createPublicOrder error: ${msg}`, { stack: error?.stack });
    res.status(status).json({ error: msg || "Failed to create order" });
  }
});

/** Verify Razorpay payment for orders created via createPublicRazorpayOrder (no Firebase login). */
exports.verifyPublicRazorpayPayment = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const keySecret = getRazorpayKeySecret();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ ok: false, error: "Missing Razorpay fields" });
      return;
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac("sha256", keySecret).update(payload).digest("hex");
    const sig = String(razorpay_signature).trim();
    const ok =
      expected.length === sig.length &&
      expected.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"));

    if (!ok) {
      res.status(400).json({ ok: false, error: "Invalid signature" });
      return;
    }

    const db = getFirestore();
    const orderRef = db.collection("razorpayOrders").doc(String(razorpay_order_id));

    const result = await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error("Unknown order");
      const orderData = orderSnap.data() || {};
      if (orderData.publicTopup !== true) {
        const err = new Error("Order is not a public top-up order");
        err.code = 403;
        throw err;
      }

      const targetUid = String(orderData.uid || "").trim();
      if (!targetUid) throw new Error("Invalid order");

      const userRef = getUserRef(targetUid);

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
      tx.set(userRef, { credits: nextCredits, email: orderData.email || '', updatedAt: FieldValue.serverTimestamp() }, { merge: true });

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
          publicTopup: true,
          email: orderData.email || null,
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
    logger.error("[razorpay] verifyPublicPayment error", { message: error?.message, stack: error?.stack });
    const code = Number(error?.code);
    const status = code === 403 ? 403 : 500;
    res.status(status).json({ ok: false, error: error?.message || "Failed to verify payment" });
  }
});

/**
 * Legacy URL — credits are no longer added without Razorpay. Responds 410 so older clients
 * (or cached bundles) get a clear JSON message instead of a missing-function 500.
 */
exports.publicCreditTopup = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  res.status(410).json({
    ok: false,
    error:
      "Credits require Razorpay checkout. POST /api/razorpay/createPublicOrder with { email, credits }, pay in Razorpay, then POST /api/razorpay/verifyPublicPayment with razorpay_order_id, razorpay_payment_id, razorpay_signature. Rebuild the app if you still see this.",
  });
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

/**
 * Public init endpoint: anyone can call it.
 * It makes the user with email === SUPER_ADMIN_EMAIL a super admin.
 *
 * Safeguards:
 * - Idempotent: if a super admin already exists, it does nothing.
 * - Does not trust request body; always uses env email.
 *
 * Route: /api/init (hosting rewrite)
 */
exports.initSuperAdmin = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const configured = getConfiguredSuperAdminEmail();
    if (!configured) {
      res.status(503).json({ ok: false, error: "SUPER_ADMIN_EMAIL is not configured" });
      return;
    }

    if (await hasAnySuperAdmin()) {
      res.json({ ok: true, initialized: false, reason: "super_admin_already_exists" });
      return;
    }

    const user = await admin.auth().getUserByEmail(configured);
    await getUserRef(user.uid).set(
      {
        superAdmin: true,
        email: user.email || configured,
        superAdminGrantedAt: FieldValue.serverTimestamp(),
        superAdminInit: "public_api",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    logger.warn("[admin] initSuperAdmin granted", { uid: user.uid, email: configured });
    res.json({ ok: true, initialized: true, uid: user.uid, email: configured });
  } catch (error) {
    const status =
      error?.code === "auth/user-not-found"
        ? 404
        : 500;
    logger.error("[admin] initSuperAdmin error", { message: error?.message });
    res.status(status).json({ ok: false, error: error?.message || "Failed to init super admin" });
  }
});

/** Returns whether the current user is a super admin (API-only helper for UI). */
exports.getAdminMe = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    const snap = await getUserRef(auth.uid).get();
    res.json({ ok: true, superAdmin: snap.data()?.superAdmin === true });
  } catch (error) {
    const code = Number(error?.code);
    const status = code === 401 ? 401 : 500;
    res.status(status).json({ ok: false, error: error?.message || "Failed to load admin status" });
  }
});

/** Admin dashboard: aggregated stats. Super admin only. */
exports.getAdminDashboard = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    if (!(await isSuperAdminUser(auth.uid))) {
      res.status(403).json({ ok: false, error: "Super admin privileges required" });
      return;
    }

    const db = getFirestore();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [userCountSnap, usersSnap, registrationsCountSnap, batchCountSnap, creditedOrdersSnap] =
      await Promise.all([
        db.collection("users").count().get(),
        db.collection("users").orderBy("credits", "desc").limit(ADMIN_DASHBOARD_USERS_LIMIT).get(),
        db.collection("registrations").count().get(),
        db.collection("batchSubmissions").count().get(),
        db.collection("razorpayOrders").where("status", "==", "credited").get(),
      ]);

    const totalUsers = userCountSnap.data().count;
    let totalCredits = 0;
    const usersByCredits = [];
    for (const doc of usersSnap.docs) {
      const d = doc.data();
      const c = Number(d.credits || 0);
      totalCredits += c;
      usersByCredits.push({
        uid: doc.id,
        email: d.email || null,
        credits: c,
        superAdmin: d.superAdmin === true,
        createdAtMs: d.createdAt?.toMillis ? d.createdAt.toMillis() : null,
      });
    }
    usersByCredits.sort((a, b) => b.credits - a.credits);

    const totalRegistrations = registrationsCountSnap.data().count;
    const totalBatchSubmissions = batchCountSnap.data().count;

    let totalRevenue = 0;
    const ordersWithTime = [];
    for (const doc of creditedOrdersSnap.docs) {
      const d = doc.data();
      totalRevenue += Number(d.planInr || 0);
      const createdAtMs = d.createdAt?.toMillis ? d.createdAt.toMillis() : null;
      ordersWithTime.push({
        id: doc.id,
        amount: Number(d.planInr || 0),
        credits: Number(d.credits || 0),
        email: d.email || null,
        createdAtMs,
        _sort: createdAtMs || 0,
      });
    }
    ordersWithTime.sort((a, b) => b._sort - a._sort);
    const recentOrders = ordersWithTime.slice(0, 20);

    const [regTodaySnap, regMonthSnap, batchProcSnap, batchErrSnap, batchPendSnap] = await Promise.all([
      db.collection("registrations").where("createdAt", ">=", todayStart).count().get(),
      db.collection("registrations").where("createdAt", ">=", thisMonthStart).count().get(),
      db.collection("batchSubmissions").where("status", "==", "processed").count().get(),
      db.collection("batchSubmissions").where("status", "==", "error").count().get(),
      db.collection("batchSubmissions").where("status", "==", "pending").count().get(),
    ]);

    const activeModel = await getExtractionModel();
    res.json({
      ok: true,
      totalUsers,
      totalCredits,
      totalRegistrations,
      totalBatchSubmissions,
      totalRevenue,
      registrationsToday: regTodaySnap.data().count,
      registrationsThisMonth: regMonthSnap.data().count,
      batchStats: {
        processed: batchProcSnap.data().count,
        error: batchErrSnap.data().count,
        pending: batchPendSnap.data().count,
      },
      usersByCredits: usersByCredits.slice(0, 50),
      recentOrders,
      extractionModel: activeModel,
    });
  } catch (error) {
    const code = Number(error?.code);
    const status = code === 401 ? 401 : code === 403 ? 403 : 500;
    logger.error("[admin] dashboard error", { message: error?.message });
    res.status(status).json({ ok: false, error: error?.message || "Failed to load dashboard" });
  }
});

/**
 * API-only: grant credits to a user by email. Caller must have superAdmin on users/{uid} (via claimSuperAdmin).
 */
exports.adminGrantCredits = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    if (!(await isSuperAdminUser(auth.uid))) {
      res.status(403).json({ ok: false, error: "Super admin privileges required" });
      return;
    }

    await assertWithinRateLimit(auth.uid, "adminGrantCredits", 120, 60_000);

    const targetEmail = normalizeEmail(req.query?.email);
    if (!targetEmail) {
      res.status(400).json({ ok: false, error: "Missing or invalid email" });
      return;
    }
    const creditsToAdd = Number.parseInt(String(req.query?.credits ?? ""), 10);
    if (!Number.isFinite(creditsToAdd) || creditsToAdd < 1 || creditsToAdd > ADMIN_GRANT_MAX_PER_CALL) {
      res.status(400).json({
        ok: false,
        error: `credits must be an integer between 1 and ${ADMIN_GRANT_MAX_PER_CALL}`,
      });
      return;
    }

    let targetUser;
    try {
      targetUser = await admin.auth().getUserByEmail(targetEmail);
    } catch (e) {
      if (e?.code === "auth/user-not-found") {
        res.status(404).json({ ok: false, error: "No Firebase user with that email" });
        return;
      }
      throw e;
    }

    const targetUid = targetUser.uid;
    const db = getFirestore();
    const targetRef = getUserRef(targetUid);
    const adminEmail = normalizeEmail(auth.email) || auth.uid;

    const result = await db.runTransaction(async (tx) => {
      const targetSnap = await tx.get(targetRef);
      const currentCredits = Number(targetSnap.data()?.credits || 0);
      const nextCredits = (Number.isFinite(currentCredits) ? currentCredits : 0) + creditsToAdd;
      tx.set(
        targetRef,
        {
          credits: nextCredits,
          email: targetUser.email || targetEmail,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      const ledgerRef = targetRef.collection("creditLedger").doc();
      tx.set(ledgerRef, {
        createdAt: FieldValue.serverTimestamp(),
        delta: creditsToAdd,
        balanceAfter: nextCredits,
        type: "admin_grant",
        label: `Admin grant — +${creditsToAdd} credits`,
        meta: {
          grantedByUid: auth.uid,
          grantedByEmail: adminEmail,
          targetEmail,
        },
      });
      return { credits: nextCredits };
    });

    logger.info("[admin] credits granted", {
      grantedBy: auth.uid,
      targetUid,
      targetEmail,
      credits: creditsToAdd,
    });

    res.json({
      ok: true,
      targetUid,
      targetEmail,
      credits: result.credits,
      granted: creditsToAdd,
    });
  } catch (error) {
    const code = Number(error?.code);
    const status = code === 401 ? 401 : code === 429 ? 429 : 500;
    logger.error("[admin] adminGrantCredits error", { message: error?.message });
    res.status(status).json({ ok: false, error: error?.message || "Failed to grant credits" });
  }
});

const batchSubmissionRuntimeOpts = {
  maxInstances: BATCH_MAX_INSTANCES,
  timeoutSeconds: Math.ceil(Math.max(BATCH_ENTRY_TIMEOUT_MS, GEMINI_TIMEOUT_MS, PDF_FETCH_TIMEOUT_MS) / 1000) + 10,
};

/**
 * Shared batch PDF → bill (before AI) → Gemini → mark processed.
 * Credits are held before Gemini so API quota cannot be farmed without balance.
 */
async function runBatchSubmissionWorker(snap, submissionId) {
  const submission = snap.data();
  if (!submission || submission.status !== "pending") {
    return null;
  }

  const batchUidEarly = String(submission.userId || "").trim();

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

      const batchUid = batchUidEarly;
      if (!batchUid) {
        throw new Error("Missing userId on submission (required for AI billing)");
      }

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

        if (pdfBytes > MAX_BATCH_PDF_BYTES) {
          throw new Error(`PDF too large (${pdfBytes} bytes, max ${MAX_BATCH_PDF_BYTES})`);
        }

        const base64Data = Buffer.from(arrayBuffer).toString('base64');

        const debitResult = await debitBatchSubmissionIfNeeded(snap.ref, submissionId, batchUid);
        logLine("info", submissionId, "billing:debit", "ok", debitResult);
        if (debitResult.alreadySettled) {
          throw new Error("Submission already billed; unexpected state");
        }

        const ai = createGenaiClient();

        const prompt = `
          You are a highly accurate OCR + data extraction system for Indian Vehicle Registration Certificates (RC).
          Analyze the provided PDF and extract ONLY the values needed to fill our form.

          OUTPUT REQUIREMENTS
          - Return ONLY a single JSON object. No markdown, no code fences, no explanation.
          - Always return ALL keys listed below. If a value is missing/unclear, return "" (empty string).
          - Never invent values. Prefer "" over guessing.

          REQUIRED JSON KEYS (exact spelling):
          regnNo, regdOwner, swdOf, address, regnDate, manufacturingDt, regdValidity,
          colour, fuel, vehicleClass, bodyType, manufacturer, modelNo,
          chassisNo, engineNo,
          cubicCapacity, wheelBase, unladenWt, rlw,
          seatCapacity, standCapacity, noOfCyc,
          ownerSerial, taxPaidUpTo,
          hypothecatedTo, issuingAuthority, purpose

          WHERE TO FIND EACH KEY IN THE RC (use label anchors; labels may vary in spacing/case):
          - regnNo: near labels "REGN. NO", "REG NO", "REGISTRATION NO", "Registration Number". Often top section.
          - regdOwner: near "OWNER NAME", "NAME", "REGISTERED OWNER", "REGD OWNER".
          - swdOf: near "S/W/D OF", "S/O", "W/O", "D/O", "SON OF", "WIFE OF", "DAUGHTER OF". Extract the person name that follows.
          - address: use TEMPORARY address when both TEMPORARY and PERMANENT exist. Anchors: "ADDRESS", "TEMPORARY ADDRESS", "PRESENT ADDRESS". Do not include commas. Include "HR " (with space) immediately before the pincode.
          - regnDate: near "REGN DATE", "REGISTRATION DATE", "DATE OF REGISTRATION". Output DD-MM-YYYY.
          - manufacturingDt: near "MFG DATE", "MONTH/YR OF MFG", "MFG", "MANUFACTURING DATE". Output MM/YYYY (two-digit month) always.
          - regdValidity: if issuingAuthority is RTA-type (starts with "RTA " + place), set exactly "As per Fitness". Otherwise use the date near "Fitness valid upto"/"Fitness valid updo"/"FITNESS VALID UPTO". Output DD-MM-YYYY.
          - colour: near "COLOUR", "COLOR".
          - fuel: near "FUEL", "FUEL USED".
          - vehicleClass: near "CLASS", "VEHICLE CLASS", "CLASS OF VEHICLE". Remove any parenthetical part including parentheses; title-case if source is all caps.
          - bodyType: near "BODY TYPE", "BODY", "TYPE OF BODY".
          - manufacturer: near "MAKER", "MFR", "MANUFACTURER", "MAKER'S NAME". Prefer the maker/company name (not dealer).
          - modelNo: near "MODEL", "MODEL NO", "TRADE NAME", "VARIANT". Return exactly as printed.
          - chassisNo: near "CHASSIS NO", "CH. NO", "VIN", "CHASSIS NUMBER". Extract full alphanumeric string.
          - engineNo: near "ENGINE NO", "ENG. NO", "ENGINE NUMBER". Extract full alphanumeric string.
          - cubicCapacity: near "C.C.", "CUBIC CAPACITY", "ENGINE CAPACITY". Return digits only; no "CC/cc". Preserve exact decimal if printed (do not round).
          - wheelBase: near "WHEEL BASE", "WHEELBASE". Return digits only; no units.
          - unladenWt: near "UNLADEN WT", "ULW", "UNLADEN WEIGHT", "KERB WT". Return digits only; no "kg".
          - rlw: near "R.L.W.", "REGISTERED LADEN WEIGHT", "LADEN", "GROSS LADEN". MUST be the laden value only. Return digits only; no "kg".
          - seatCapacity: near "SEAT CAPACITY", "SEATING CAPACITY", "NO OF SEATS". Return digits only.
          - standCapacity: near "STAND CAPACITY", "STANDING CAPACITY". Return digits only.
          - noOfCyc: near "NO OF CYL", "NO. OF CYLINDERS", "CYL". Return digits only.
          - ownerSerial: near "OWNER SR", "OWNER SERIAL", "OWNER SL NO". Always two digits (1 -> "01").
          - taxPaidUpTo: near "TAX PAID UPTO", "TAX PAID UP TO", "TAX VALID UPTO". Output exactly as printed.
          - hypothecatedTo: near "HYPOTHECATED TO", "HP TO", "FINANCIER". Return ONLY institution name (single line). Max 30 chars. If no hypothecation, "".
          - issuingAuthority: near "ISSUING AUTHORITY", "REGISTERING AUTHORITY", "RTA/RTO/DTO/SDM". Output exactly PREFIX + one space + LOCATION:
              * If RC text is like "RTA KHARKHONDA", output exactly that.
              * Otherwise output "SDM " + location.
          - purpose: near "PURPOSE", "USE", "TYPE OF USE".

          GLOBAL NORMALIZATION RULES
          - Dates: regnDate and regdValidity must be DD-MM-YYYY when they are dates.
          - manufacturingDt must be MM/YYYY only.
          - Numbers: do not include units (KG/MM/CC). Extract full chassis/engine strings.
        `;

        const activeModel = await getExtractionModel();
        logLine(
          "info",
          submissionId,
          "gemini:start",
          `model=${activeModel} timeout=${GEMINI_TIMEOUT_MS}ms`,
          { model: activeModel, geminiTimeoutMs: GEMINI_TIMEOUT_MS }
        );
        const t1 = Date.now();
        const extractionResponse = await withTimeout("gemini_generateContent", GEMINI_TIMEOUT_MS, async () => {
          return await ai.models.generateContent({
            model: activeModel,
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

      const balSnap = await getUserRef(batchUid).get();
      const remaining = Number(balSnap.data()?.credits ?? 0);
      logLine(
        "info",
        submissionId,
        "billing",
        `balance_after_debit=${Number.isFinite(remaining) ? remaining : "?"}`,
        { uid: batchUid, remaining }
      );

      await snap.ref.update({
        status: 'processed',
        extractedData: result.extractedData,
        aiBillingState: 'settled',
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

      await refundBatchAiIfDebited(snap.ref, submissionId, batchUidEarly);

      let errorUpdate = {
        status: 'error',
        errorMessage: code ? `${code}: ${message}` : message,
        errorCode: code || null,
        failedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: null,
        leaseExpiresAtMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (code === "INSUFFICIENT_CREDITS") {
        errorUpdate = {
          ...errorUpdate,
          errorCode: "INSUFFICIENT_CREDITS",
          errorMessage:
            message || `Insufficient credits for AI processing (need ${AI_PROCESSING_CREDIT_COST} per file)`,
        };
      }
      
      await snap.ref.update(errorUpdate);
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
      const data = docSnap.data() || {};
      const uid = String(data.userId || "").trim();
      if (data.aiBillingState === "debited" && uid) {
        await refundBatchAiIfDebited(docSnap.ref, docSnap.id, uid);
      }
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

/** Admin settings: update global settings. Super admin only. */
exports.adminUpdateSettings = functions.https.onRequest(async (req, res) => {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    const auth = await requireAuth(req);
    if (!(await isSuperAdminUser(auth.uid))) {
      res.status(403).json({ ok: false, error: "Super admin privileges required" });
      return;
    }

    const { extractionModel } = req.body || {};
    if (typeof extractionModel !== "string" || !extractionModel.trim()) {
      res.status(400).json({ ok: false, error: "Invalid extractionModel parameter" });
      return;
    }

    const db = getFirestore();
    await db.collection("settings").doc("global").set({
      extractionModel: extractionModel.trim(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.email || auth.uid,
    }, { merge: true });

    res.json({ ok: true, extractionModel: extractionModel.trim() });
  } catch (error) {
    logger.error("[admin] update settings error", { message: error?.message });
    res.status(500).json({ ok: false, error: error?.message || "Failed to update settings" });
  }
});

/** Creates a Firestore user document when a new user signs up via Firebase Auth. */
exports.createUserDoc = functions.auth.user().onCreate(async (user) => {
  await getUserRef(user.uid).set({
    credits: 0,
    email: user.email || '',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.info("[auth] user doc created", { uid: user.uid, email: user.email || '' });
});