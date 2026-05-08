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

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

/** Email allowed to call claimSuperAdmin and receive `superAdmin: true` on their user doc. */
const getConfiguredSuperAdminEmail = () => {
  const raw = process.env.SUPER_ADMIN_EMAIL;
  if (!raw || !String(raw).trim()) return null;
  return normalizeEmail(raw);
};

const ADMIN_GRANT_MAX_PER_CALL = asInt(process.env.ADMIN_GRANT_MAX_PER_CALL, 50_000);

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
