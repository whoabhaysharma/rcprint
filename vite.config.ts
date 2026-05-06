import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(), 
      tailwindcss(),
      {
        name: 'local-firebase-function-mock',
        configureServer(server) {
          server.middlewares.use('/api/extractRcData', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              return res.end('Method Not Allowed');
            }
            
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
              try {
                const { base64Data, base64Image, mimeType, customPrompt } = JSON.parse(body);
                const apiKey = env.GEMINI_API_KEY;
                if (!apiKey) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  return res.end(JSON.stringify({error: 'Missing GEMINI_API_KEY in .env.local'}));
                }
                const payloadData = base64Data || base64Image;
                const payloadMimeType = mimeType || 'image/jpeg';
                if (!payloadData) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  return res.end(JSON.stringify({error: 'Missing file payload for extraction'}));
                }

                // Dynamically import genai securely in Node.js server
                const { GoogleGenAI } = await import('@google/genai');
                const ai = new GoogleGenAI({ apiKey });
                
                const prompt = `
                  You are a highly accurate OCR and data extraction system for Vehicle Registration Certificates (RC).
                  Analyze the provided image and extract all relevant vehicle information.
                  Return a JSON object with the following keys. If a value is missing, return an empty string.
                  Keys:
                  regnNo, regnDate, manufacturer, fuel, vehicleClass, bodyType, chassisNo, engineNo, modelNo, regdOwner, swdOf, address, cubicCapacity, seatCapacity, standCapacity, wheelBase, unladenWt, noOfCyc, ownerSerial, taxPaidUpTo, regdValidity, colour, rlw, issuingAuthority, purpose, hypothecatedTo, manufacturingDt.
                  
                  CRITICAL: 
                  1. Return ONLY the JSON object. No other text.
                  2. Date formatting: Use DD-MM-YYYY for regnDate and for regdValidity when the value is a calendar date (not the phrase "As per Fitness"). For manufacturingDt only, output **MM/YYYY** always: two-digit month (01–12), four-digit year, slash separator (e.g. 08/2024). Read the RC and normalize to this form (e.g. 8/2024 → 08/2024, 10-2024 → 10/2024).
                  3. Extract the Registration Number (e.g., HR26EB5601) accurately.
                  4. Extract the Owner details and Address accurately.
                  5. If any detail is missing, return "" (empty string) only. Never return placeholder text like "NO HYPOTHECATION DETAILS FOUND", "NOT FOUND", "N/A", "FALSE", or "NULL".
                  6. If hypothecation details are not present, set hypothecatedTo to "".
                  7. Extract every listed key from the document if present; do not skip fields.
                  8. For seatCapacity, standCapacity, wheelBase, unladenWt, noOfCyc, and rlw, return only the numeric value without units like KG or MM. For cubicCapacity, return only the numeric value without CC or cc; when the certificate shows a decimal (e.g. 1248.5 or 2184.00), keep that exact decimal form — do not round to a whole number.
                  9. For ownerSerial, always return two-digit format with leading zero when single digit (1 => 01, 2 => 02, ...).
                  10. Do not use weight units like kg; include only the numeric value.
                  11. In address, include "HR " (with a space) just before the pincode.
                  12. Use temporary address, not permanent address, when both are present.
                  13. Do not include any commas in address.
                  14. issuingAuthority and regdValidity — output final values in JSON. The client does not reformat these (only trims whitespace).
                      - issuingAuthority: Always output PREFIX then one space then LOCATION. LOCATION is only the issuing place. For long department lines (e.g. STATE TRANSPORT DEPARTMENT AUTHORITY - PANCHKULA), LOCATION is the place after the final hyphen or after AUTHORITY as appropriate; PREFIX is SDM unless the line begins with a short office token (RTA, RTO, DTO, ARTO, SDM, MLO, etc.). Never return the full department sentence. You may use a newline in the string if needed.
                      - regdValidity: If issuingAuthority is RTA-type (RTA + place), set "As per Fitness". Otherwise Fitness valid upto in DD-MM-YYYY.
                  15. hypothecatedTo: Extract only the bank/financier name (not branch address, loan numbers, or "Hypothecated to" label text). Hard limit **30 characters** — shorten with sensible abbreviations if required. Single line, no newlines.
                  16. vehicleClass: Strip all parenthetical parts including the parentheses themselves (remove whatever appears inside (...)). Example: "MOTOR CAB (LVP)" → "Motor Cab". Title-case the remaining class text when the source is all caps.

                  Additional User Rules to follow strictly:
                  ${customPrompt || "None"}
                `;

                const timeoutMs = 25000;
                const response = await Promise.race([
                  ai.models.generateContent({
                    model: "gemini-3-flash-preview",
                    contents: [
                      { inlineData: { data: payloadData, mimeType: payloadMimeType } },
                      { text: prompt }
                    ],
                    config: { responseMimeType: "application/json" }
                  }),
                  new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs}ms`)), timeoutMs);
                  })
                ]) as { text: string };

                res.setHeader('Content-Type', 'application/json');
                res.end(response.text);
              } catch (err: any) {
                const message = err?.message || 'Unknown extraction error';
                console.error('extractRcData error:', message);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({error: message}));
              }
            });
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
