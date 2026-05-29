# RC Extraction Eval

Drop PDFs into a folder, run a script, and get a per-key diff report against expected JSON (if you provide it).

This **does not modify** your extraction prompt and **does not normalize** the extracted JSON values. It only reports differences.

## Setup

- Ensure `GEMINI_API_KEY` is set in either:
  - repo root `.env`, or
  - `functions/.env`

## Folder layout

```
eval/
  pdfs/
    file1.pdf
    file2.pdf
  expected/
    file1.json
    file2.json
```

- `expected/<name>.json` is optional. If missing, the script still extracts and saves results, but won’t compute diffs for that PDF.

## Run

From repo root:

```bash
node eval/eval-rc.mjs
```

By default it uses:
- extraction model: `gemini-3.1-flash-lite`
- verify/fix pass: enabled (same model)

Optional flags:

```bash
node eval/eval-rc.mjs \
  --pdfDir eval/pdfs \
  --expectedDir eval/expected \
  --out eval/results.json \
  --model gemini-3.1-flash-lite \
  --verifyModel gemini-3.1-flash-lite \
  --no-verify \
  --promptSource functions/index.js
```

## Output

- Writes `eval/results.json` (or `--out`) with:
  - `summary` (accuracy over expected keys)
  - `results[]` per PDF:
    - raw extracted object (parsed JSON)
    - list of key diffs vs expected
    - parse error + raw text if model didn’t return valid JSON

