const { onRequest } = require("firebase-functions/v2/https");
const { GoogleGenAI } = require("@google/genai");

exports.extractRcData = onRequest({ cors: true }, async (req, res) => {
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
