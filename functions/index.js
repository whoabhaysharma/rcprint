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
      2. Dates: Use DD-MM-YYYY for regnDate and for regdValidity when the value is a calendar date (not "As per Fitness"). For manufacturingDt only, transcribe exactly as printed on the RC — same characters and separators; never reformat to MM/YYYY, DD-MM-YYYY, ISO, or any other normalized form.
      3. Names: Extract EXACTLY as written.
      4. Numbers: Extract Chassis/Engine numbers in full. For cubicCapacity, use digits only with no CC/cc suffix; when the RC shows a decimal capacity, preserve that exact decimal as printed — never round it to an integer.
      5. Do not use weight units like kg; include only the numeric value.
      6. In address, include "HR " (with a space) just before the pincode.
      7. Use temporary address, not permanent address, when both are present.
      8. Do not include any commas in address.
      9. For ownerSerial, always return two-digit format with leading zero when single digit (1 => 01, 2 => 02, ...).
      10. issuingAuthority and regdValidity — read the certificate and output final values (the client does not rewrite these):
          - issuingAuthority: When the authority line already shows an office designation before the place name (e.g. RTA, SDM, DTO, RTO, ARTO, MLO, or similar), transcribe it exactly as printed. When the line is only a place or district name with no such prefix, output "SDM " followed by that place name (example: document shows only "Gurgaon" → "SDM Gurgaon"). When the document shows "RTA" with a place, keep that form (e.g. "RTA Gurgaon") as printed.
          - regdValidity: If issuingAuthority contains "RTA" (any casing), set regdValidity exactly to "As per Fitness". If issuingAuthority does not contain "RTA", set regdValidity to the Fitness valid upto date from the document (labels may read "Fitness valid upto" or be misread as "Fitness valid updo") in DD-MM-YYYY — use that concrete fitness date as the expiry/validity for non-RTA authorities.
      11. vehicleClass: Strip all parenthetical parts including the parentheses themselves (remove whatever appears inside (...)). Example: "MOTOR CAB (LVP)" → "Motor Cab". Title-case the remaining class text when the source is all caps.

      Additional Rules:
      ${customPrompt || "None"}
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
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
