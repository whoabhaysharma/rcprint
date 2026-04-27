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
    const { base64Image, customPrompt } = req.body;
    if (!base64Image) {
      res.status(400).send("Missing base64Image");
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

      Additional Rules:
      ${customPrompt || "None"}
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { inlineData: { data: base64Image, mimeType: "image/jpeg" } },
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
