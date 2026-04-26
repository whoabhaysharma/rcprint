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
                const { base64Image, customPrompt } = JSON.parse(body);
                // Dynamically import genai securely in Node.js server
                const { GoogleGenAI } = await import('@google/genai');
                const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
                
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

                  Additional User Rules to follow strictly:
                  ${customPrompt || "None"}
                `;

                const response = await ai.models.generateContent({
                  model: "gemini-3-flash-preview",
                  contents: [
                    { inlineData: { data: base64Image, mimeType: "image/jpeg" } },
                    { text: prompt }
                  ],
                  config: { responseMimeType: "application/json" }
                });

                res.setHeader('Content-Type', 'application/json');
                res.end(response.text);
              } catch (err: any) {
                console.error(err);
                res.statusCode = 500;
                res.end(err.message);
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
