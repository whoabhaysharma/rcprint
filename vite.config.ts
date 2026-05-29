import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const firebaseProjectId = (() => {
    try {
      const raw = fs.readFileSync(path.resolve(__dirname, '.firebaserc'), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed?.projects?.default || '';
    } catch {
      return '';
    }
  })();
  const functionsBaseUrl = firebaseProjectId
    ? `http://127.0.0.1:5001/${firebaseProjectId}/us-central1`
    : '';
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
            const authHeader = String(req.headers.authorization || '');
            if (!authHeader.startsWith('Bearer ')) {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ error: 'Authorization required for AI extraction' }));
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
                  - regnNo: "REGN. NO"/"REG NO"/"REGISTRATION NO"/"Registration Number" (often top section).
                  - regdOwner: "OWNER NAME"/"REGISTERED OWNER"/"REGD OWNER".
                  - swdOf: "S/W/D OF"/"S/O"/"W/O"/"D/O"/"SON OF"/"WIFE OF"/"DAUGHTER OF" — extract the person name after it.
                  - address: use TEMPORARY/PRESENT address when both exist. "ADDRESS"/"TEMPORARY ADDRESS"/"PRESENT ADDRESS". No commas. Insert "HR " before pincode.
                  - regnDate: "REGN DATE"/"REGISTRATION DATE"/"DATE OF REGISTRATION" → DD-MM-YYYY.
                  - manufacturingDt: "MFG DATE"/"MONTH/YR OF MFG"/"MANUFACTURING DATE" → MM/YYYY (two-digit month).
                  - regdValidity: if issuingAuthority starts with "RTA " + place => exactly "As per Fitness"; else use "Fitness valid upto/updo" date → DD-MM-YYYY.
                  - colour: "COLOUR"/"COLOR".
                  - fuel: "FUEL".
                  - vehicleClass: "CLASS"/"VEHICLE CLASS"/"CLASS OF VEHICLE" (strip parentheses; title-case if all caps).
                  - bodyType: "BODY TYPE"/"BODY".
                  - manufacturer: "MAKER"/"MFR"/"MANUFACTURER"/"MAKER'S NAME" (maker/company, not dealer).
                  - modelNo: "MODEL"/"MODEL NO"/"TRADE NAME"/"VARIANT".
                  - chassisNo: "CHASSIS NO"/"CH. NO"/"VIN".
                  - engineNo: "ENGINE NO"/"ENG. NO".
                  - cubicCapacity: "C.C."/ "CUBIC CAPACITY"/"ENGINE CAPACITY" (digits only; keep decimals; no CC).
                  - wheelBase: "WHEEL BASE"/"WHEELBASE" (digits only).
                  - unladenWt: "UNLADEN WT"/"ULW"/"KERB WT" (digits only; no kg).
                  - rlw: "R.L.W."/"REGISTERED LADEN WEIGHT"/"LADEN"/"GROSS LADEN" (laden only; digits only; no kg).
                  - seatCapacity: "SEAT CAPACITY"/"NO OF SEATS" (digits only).
                  - standCapacity: "STAND CAPACITY" (digits only).
                  - noOfCyc: "NO OF CYL"/"CYLINDERS" (digits only).
                  - ownerSerial: "OWNER SR"/"OWNER SERIAL"/"OWNER SL NO" (two digits: 1->01).
                  - taxPaidUpTo: "TAX PAID UPTO/UP TO"/"TAX VALID UPTO" (output as printed).
                  - hypothecatedTo: "HYPOTHECATED TO"/"HP TO"/"FINANCIER" — only institution name, max 30 chars, single line, else "".
                  - issuingAuthority: "ISSUING AUTHORITY"/"REGISTERING AUTHORITY"/office line (RTA/RTO/DTO/SDM). Output:
                      * If RC has "RTA <PLACE>" output that exactly
                      * Otherwise "SDM <PLACE>"
                  - purpose: "PURPOSE"/"USE"/"TYPE OF USE".

                  GLOBAL NORMALIZATION RULES
                  - Dates: regnDate & regdValidity as DD-MM-YYYY when dates.
                  - manufacturingDt must be MM/YYYY only (normalize 8/2024 -> 08/2024; 10-2024 -> 10/2024).
                  - Numbers: do not include units (KG/MM/CC). Extract full chassis/engine strings.

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

          server.middlewares.use('/api/razorpay/createOrder', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              return res.end('Method Not Allowed');
            }
            if (!functionsBaseUrl) {
              res.statusCode = 500;
              return res.end('Missing Firebase project id (.firebaserc)');
            }

            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
              try {
                const authHeader = String(req.headers.authorization || '');
                const upstream = await fetch(`${functionsBaseUrl}/createRazorpayOrder`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                  },
                  body,
                });
                const text = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                res.end(text);
              } catch (err: any) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err?.message || 'Failed to call functions emulator' }));
              }
            });
          });

          server.middlewares.use('/api/razorpay/verifyPayment', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              return res.end('Method Not Allowed');
            }
            if (!functionsBaseUrl) {
              res.statusCode = 500;
              return res.end('Missing Firebase project id (.firebaserc)');
            }

            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
              try {
                const authHeader = String(req.headers.authorization || '');
                const upstream = await fetch(`${functionsBaseUrl}/verifyRazorpayPayment`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                  },
                  body,
                });
                const text = await upstream.text();
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                res.end(text);
              } catch (err: any) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err?.message || 'Failed to call functions emulator' }));
              }
            });
          });

          server.middlewares.use('/api/credits/me', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              return res.end('Method Not Allowed');
            }
            if (!functionsBaseUrl) {
              res.statusCode = 500;
              return res.end('Missing Firebase project id (.firebaserc)');
            }
            try {
              const upstream = await fetch(`${functionsBaseUrl}/getMyCredits`, {
                method: 'GET',
                headers: { Authorization: String(req.headers.authorization || '') },
              });
              const text = await upstream.text();
              res.statusCode = upstream.status;
              res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
              res.end(text);
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || 'Failed to call functions emulator' }));
            }
          });

          server.middlewares.use('/api/credits/history', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              return res.end('Method Not Allowed');
            }
            if (!functionsBaseUrl) {
              res.statusCode = 500;
              return res.end('Missing Firebase project id (.firebaserc)');
            }
            try {
              const u = new URL(req.url || '/', 'http://vite.local');
              const qs = u.search || '';
              const upstream = await fetch(`${functionsBaseUrl}/getCreditHistory${qs}`, {
                method: 'GET',
                headers: { Authorization: String(req.headers.authorization || '') },
              });
              const text = await upstream.text();
              res.statusCode = upstream.status;
              res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
              res.end(text);
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || 'Failed to call functions emulator' }));
            }
          });

          const proxyToFunction = (path: string, functionName: string, method: 'GET' | 'POST') => {
            server.middlewares.use(path, async (req, res) => {
              if (req.method !== method) {
                res.statusCode = 405;
                return res.end('Method Not Allowed');
              }
              if (!functionsBaseUrl) {
                res.statusCode = 500;
                return res.end('Missing Firebase project id (.firebaserc)');
              }
              const u = new URL(req.url || '/', 'http://vite.local');
              const qs = u.search || '';
              if (method === 'GET') {
                try {
                  const upstream = await fetch(`${functionsBaseUrl}/${functionName}${qs}`, {
                    method: 'GET',
                    headers: { Authorization: String(req.headers.authorization || '') },
                  });
                  const text = await upstream.text();
                  res.statusCode = upstream.status;
                  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                  res.end(text);
                } catch (err: any) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: err?.message || 'Failed to call functions emulator' }));
                }
                return;
              }

              let body = '';
              req.on('data', (chunk) => {
                body += chunk.toString();
              });
              req.on('end', async () => {
                try {
                  const upstream = await fetch(`${functionsBaseUrl}/${functionName}${qs}`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: String(req.headers.authorization || ''),
                    },
                    body: body || '{}',
                  });
                  const text = await upstream.text();
                  res.statusCode = upstream.status;
                  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                  res.end(text);
                } catch (err: any) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: err?.message || 'Failed to call functions emulator' }));
                }
              });
            });
          };

          proxyToFunction('/api/init', 'initSuperAdmin', 'POST');
          proxyToFunction('/api/admin/dashboard', 'getAdminDashboard', 'GET');
          proxyToFunction('/api/admin/grantCredits', 'adminGrantCredits', 'GET');
          proxyToFunction('/api/admin/me', 'getAdminMe', 'GET');
          proxyToFunction('/api/razorpay/createPublicOrder', 'createPublicRazorpayOrder', 'POST');
          proxyToFunction('/api/razorpay/verifyPublicPayment', 'verifyPublicRazorpayPayment', 'POST');
          proxyToFunction('/api/credits/publicTopup', 'publicCreditTopup', 'POST');

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
