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
                  2. Ensure dates are in DD-MM-YYYY format if possible.
                  3. Extract the Registration Number (e.g., HR26EB5601) accurately.
                  4. Extract the Owner details and Address accurately.
                  5. If any detail is missing, return "" (empty string) only. Never return placeholder text like "NO HYPOTHECATION DETAILS FOUND", "NOT FOUND", "N/A", "FALSE", or "NULL".
                  6. Extract registration expiry/validity very carefully into regdValidity (examples: "26-11-2039", "Valid Upto 26-11-2039").
                  7. If hypothecation details are not present, set hypothecatedTo to "".
                  8. On many RC PDFs, registration validity appears near labels like "Fitness valid upto" (sometimes OCR reads "Fitness valid updo"). Always map that date into regdValidity.
                  9. Extract every listed key from the document if present; do not skip fields.
                  10. Do not return placeholder text for missing values. If not found, strictly return "".
                  11. For numeric fields (cubicCapacity, seatCapacity, standCapacity, wheelBase, unladenWt, noOfCyc, rlw), return only numeric value without units like KG/MM/CC.
                  12. For ownerSerial, return two-digit format with leading zero if needed (01, 02, ...).

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
