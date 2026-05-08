/**
 * Credits charged per successful AI-extracted PDF in batch processing.
 * Keep in sync with `AI_PROCESSING_CREDIT_COST` in `functions/index.js`.
 * User-visible balance must cover this before AI runs; failed runs are refunded server-side.
 */
export const AI_EXTRACTION_CREDIT_COST = 2;
