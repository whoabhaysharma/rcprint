import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = {
    pdfDir: path.resolve(__dirname, "pdfs"),
    expectedDir: path.resolve(__dirname, "expected"),
    outFile: path.resolve(__dirname, "results.json"),
    model: "gemini-3.1-flash-lite",
    verifyModel: "gemini-3.1-flash-lite",
    verify: true,
    promptSource: path.resolve(__dirname, "..", "functions", "index.js"),
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pdfDir" && next) out.pdfDir = path.resolve(process.cwd(), next), i++;
    else if (a === "--expectedDir" && next) out.expectedDir = path.resolve(process.cwd(), next), i++;
    else if (a === "--out" && next) out.outFile = path.resolve(process.cwd(), next), i++;
    else if (a === "--model" && next) out.model = next, i++;
    else if (a === "--verifyModel" && next) out.verifyModel = next, i++;
    else if (a === "--no-verify") out.verify = false;
    else if (a === "--promptSource" && next) out.promptSource = path.resolve(process.cwd(), next), i++;
  }
  return out;
}

async function loadEnv() {
  // Try repo root .env then functions/.env (if present).
  dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
  dotenv.config({ path: path.resolve(__dirname, "..", "functions", ".env") });
}

async function loadPromptFromFunctionsIndex(promptSourcePath) {
  const src = await fs.readFile(promptSourcePath, "utf8");

  // Prefer prompt inside extractRc handler; fallback to first prompt literal.
  const m1 = src.match(/exports\.extractRc[\s\S]*?const prompt\s*=\s*`([\s\S]*?)`;\s*/);
  const m2 = src.match(/const prompt\s*=\s*`([\s\S]*?)`;\s*/);
  const raw = (m1?.[1] ?? m2?.[1])?.toString();
  if (!raw) {
    throw new Error(`Could not find \`const prompt = \\\`\` in ${promptSourcePath}`);
  }

  // Keep prompt as-is; only resolve the interpolation marker so the model sees concrete text.
  return raw.replaceAll("${customPrompt || \"None\"}", "None");
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function verifyAndFix({ ai, model, prompt, base64Pdf, extracted }) {
  const verifyInstruction = `
You are a strict verifier for RC extraction.
You will be given:
1) The extraction INSTRUCTION (prompt),
2) The original PDF,
3) The GENERATED JSON.

TASK:
- Check whether EVERY requirement in the INSTRUCTION is satisfied (keys present, correct key spelling, and values comply with instruction).
- If anything is missing/wrong, MODIFY the JSON to match the INSTRUCTION.
- If it already matches, return the same JSON unchanged.

CRITICAL OUTPUT RULES:
- Return ONLY a single JSON object. No extra text.
- Do NOT invent values not present in the PDF. If unclear/missing, use "" (empty string) as per instruction.
`;

  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [
        { inlineData: { data: base64Pdf, mimeType: "application/pdf" } },
        { text: verifyInstruction },
        { text: "INSTRUCTION (follow exactly):\n" + prompt },
        { text: "GENERATED JSON:\n" + JSON.stringify(extracted ?? {}, null, 2) },
      ],
    },
    config: { responseMimeType: "application/json" },
  });

  const text = response.text ?? "";
  const parsed = safeJsonParse(text);
  return { text, parsed };
}

function diffExpected(expected, actual) {
  const keys = Object.keys(expected ?? {});
  const diffs = [];
  let matched = 0;
  for (const k of keys) {
    const ev = expected?.[k];
    const av = actual?.[k];
    const same = ev === av;
    if (same) matched++;
    else diffs.push({ key: k, expected: ev, actual: av });
  }
  return { keysCompared: keys.length, matched, diffs };
}

async function main() {
  const args = parseArgs(process.argv);
  await loadEnv();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in .env (repo root) or functions/.env");
  }

  const prompt = await loadPromptFromFunctionsIndex(args.promptSource);
  const ai = new GoogleGenAI({ apiKey });

  const entries = await fs.readdir(args.pdfDir, { withFileTypes: true });
  const pdfFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (pdfFiles.length === 0) {
    throw new Error(`No PDFs found in ${args.pdfDir}`);
  }

  const results = [];

  for (const fileName of pdfFiles) {
    const pdfPath = path.join(args.pdfDir, fileName);
    const base = fileName.replace(/\.pdf$/i, "");
    const expectedPath = path.join(args.expectedDir, `${base}.json`);

    const pdfBytes = await fs.readFile(pdfPath);
    const base64Data = pdfBytes.toString("base64");

    const startedAt = Date.now();
    const response = await ai.models.generateContent({
      model: args.model,
      contents: {
        parts: [
          { inlineData: { data: base64Data, mimeType: "application/pdf" } },
          { text: prompt },
        ],
      },
      config: { responseMimeType: "application/json" },
    });

    const text = response.text ?? "";
    const parsed = safeJsonParse(text);

    let verify = null;
    let finalOk = parsed.ok;
    let finalObj = parsed.ok ? parsed.value : null;
    let finalText = parsed.ok ? null : text;
    let msVerify = 0;

    if (args.verify && parsed.ok) {
      const tVerify = Date.now();
      const v = await verifyAndFix({
        ai,
        model: args.verifyModel,
        prompt,
        base64Pdf: base64Data,
        extracted: parsed.value,
      });
      msVerify = Date.now() - tVerify;
      verify = {
        model: args.verifyModel,
        ok: v.parsed.ok,
        parseError: v.parsed.ok ? null : v.parsed.error,
      };
      if (v.parsed.ok) {
        finalOk = true;
        finalObj = v.parsed.value;
        finalText = null;
      } else {
        finalOk = false;
        finalObj = null;
        finalText = v.text;
      }
    }

    let expected = null;
    try {
      const expText = await fs.readFile(expectedPath, "utf8");
      expected = JSON.parse(expText);
    } catch {
      expected = null;
    }

    const actual = finalOk ? finalObj : null;
    const diff = expected && actual ? diffExpected(expected, actual) : null;

    results.push({
      fileName,
      pdfPath,
      model: args.model,
      verify,
      msExtract: Date.now() - startedAt,
      msVerify,
      ok: finalOk,
      parseError: finalOk ? null : (verify?.parseError ?? parsed.error),
      expectedPath: expected ? expectedPath : null,
      keysCompared: diff?.keysCompared ?? 0,
      keysMatched: diff?.matched ?? 0,
      diffs: diff?.diffs ?? [],
      extracted: actual,
      rawText: finalOk ? null : finalText,
    });
  }

  const totalCompared = results.reduce((s, r) => s + (r.keysCompared || 0), 0);
  const totalMatched = results.reduce((s, r) => s + (r.keysMatched || 0), 0);
  const filesOk = results.filter((r) => r.ok).length;

  const summary = {
    pdfDir: args.pdfDir,
    expectedDir: args.expectedDir,
    model: args.model,
    promptSource: args.promptSource,
    totalFiles: results.length,
    okFiles: filesOk,
    totalKeysCompared: totalCompared,
    totalKeysMatched: totalMatched,
    accuracy: totalCompared ? totalMatched / totalCompared : null,
    generatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(args.outFile), { recursive: true });
  await fs.writeFile(args.outFile, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");

  // Console summary (no normalization of model output; just reporting).
  console.log(JSON.stringify(summary, null, 2));
  for (const r of results) {
    if (!r.ok) {
      console.log(`- ${r.fileName}: JSON parse failed (${r.parseError})`);
      continue;
    }
    if (!r.expectedPath) {
      console.log(`- ${r.fileName}: extracted (no expected json provided)`);
      continue;
    }
    const mism = (r.diffs || []).length;
    console.log(`- ${r.fileName}: matched ${r.keysMatched}/${r.keysCompared} (mismatches=${mism})`);
    if (mism) {
      for (const d of r.diffs.slice(0, 10)) {
        console.log(`    * ${d.key}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`);
      }
      if (mism > 10) console.log(`    * ... ${mism - 10} more mismatches`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

