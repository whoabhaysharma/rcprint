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
      2. Dates: Use DD-MM-YYYY format.
      3. Names: Extract EXACTLY as written.
      4. Numbers: Extract Chassis/Engine numbers in full.
      5. Manufacturing Date: often in format MM/YYYY (e.g. 10/2024).
      6. For issuingAuthority, if there is any RTA reference in the document, return in "RTA <City>" format (example: "RTA Gurgaon"), not only city/location text.
      7. Do not use weight units like kg; include only the numeric value.
      8. In address, include "HR " (with a space) just before the pincode.
      9. Use temporary address, not permanent address, when both are present.
      10. Do not include any commas in address.
      11. If top of PDF contains "RTA Haryana" or any "RTA" reference, set regdValidity exactly as "As per Fitness" (title case), not all caps.
      12. For vehicleClass, return format "<Title Case Base> (<UPPERCASE ABBR>)". Example: "MOTOR CAB (LVP)" should become "Motor Cab (LVP)".
      13. For ownerSerial, always return two-digit format with leading zero when single digit (1 => 01, 2 => 02, ...).

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
