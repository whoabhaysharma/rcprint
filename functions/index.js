const functions = require("firebase-functions");
const { GoogleGenAI } = require("@google/genai");

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
    const { base64Data, base64Image, mimeType, customPrompt } = req.body || {};
    const payloadData = base64Data || base64Image;
    const payloadMimeType = mimeType || "image/jpeg";

    if (!payloadData) {
      res.status(400).send("Missing file payload");
      return;
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
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
      model: "gemini-3-flash-preview",
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
    
    res.json(extractedData);
  } catch (error) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: error.message });
  }
});
