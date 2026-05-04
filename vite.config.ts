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
                  2. Date formatting: Use DD-MM-YYYY for regnDate and for regdValidity when the value is a calendar date (not the phrase "As per Fitness"). For manufacturingDt only, transcribe **exactly** as printed on the RC — same characters, separators, spacing, and order; never convert it to another format (no forced MM/YYYY, DD-MM-YYYY, or ISO).
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
                  14. issuingAuthority and regdValidity — read the certificate and output final values (the client does not rewrite these):
                      - issuingAuthority: When the authority line already shows an office designation before the place name (e.g. RTA, SDM, DTO, RTO, ARTO, MLO, or similar), transcribe it exactly as printed (including spacing and casing from the document). When the line is only a place or district name with no such prefix, output "SDM " followed by that place name (example: document shows only "Gurgaon" → "SDM Gurgaon"). When the document shows "RTA" with a place, keep that form (e.g. "RTA Gurgaon") as printed.
                      - regdValidity: If issuingAuthority contains "RTA" (any casing), set regdValidity exactly to "As per Fitness". If issuingAuthority does not contain "RTA", set regdValidity to the Fitness valid upto date from the document (labels may read "Fitness valid upto" or be misread as "Fitness valid updo") in DD-MM-YYYY — use that concrete fitness date as the expiry/validity for non-RTA authorities.
                  15. vehicleClass: Strip all parenthetical parts including the parentheses themselves (remove whatever appears inside (...)). Example: "MOTOR CAB (LVP)" → "Motor Cab". Title-case the remaining class text when the source is all caps.

                  Additional User Rules to follow strictly:
                  ${customPrompt || "None"}
                `;

                const timeoutMs = 25000;
                const response = await Promise.race([
                  ai.models.generateContent({
                    model: "gemini-2.5-flash",
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
