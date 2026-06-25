async function runOCR(imageDataUrl) {
  try {
    const result = await Tesseract.recognize(imageDataUrl, 'eng');
    return result.data.text.trim();
  } catch (err) {
    // A bad photo (corrupt blob, OOM on a huge image) must not take down the
    // app — OCR is a bonus suggestion, not a required step in the walkthrough.
    console.warn('[ocr] recognize failed', err);
    return '';
  }
}

function extractSerialCandidates(ocrText) {
  if (!ocrText) return [];

  // Split on whitespace and punctuation, but keep hyphens that sit inside a
  // token (e.g. "ABC-1234-5678") since real data-plate serials are often
  // segmented that way. Leading/trailing hyphens are stripped as noise.
  const rawTokens = ocrText.split(/[^A-Za-z0-9-]+/);

  const seen = new Set();
  const candidates = [];

  for (const raw of rawTokens) {
    const token = raw.replace(/^-+|-+$/g, '');
    if (token.length < 8) continue;
    if (!/^[A-Za-z0-9-]+$/.test(token)) continue;

    const digitsOnly = /^[0-9]+$/.test(token);
    // Long pure-digit runs (UPCs, phone numbers, barcodes) aren't serials.
    if (digitsOnly && token.length > 12) continue;

    const key = token.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(token);
  }

  return candidates;
}

const OCR_TRIGGER_KEYWORDS = [
  'furnace', 'condensing unit', 'package unit', 'a-coil',
  'hot water heater', 'water heater', 'window unit',
  'microwave', 'hood', 'range', 'wall oven', 'cooktop',
  'dishwasher', 'fridge', 'refrigerator',
];

function shouldRunOCR(itemNameOrId) {
  if (!itemNameOrId) return false;
  const lower = itemNameOrId.toLowerCase();

  if (OCR_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw))) return true;

  // Fallback for renamed custom items where the name no longer matches:
  // as-01..as-09 is the HVAC/water-heater id range, kt-12..kt-17 is appliances.
  if (lower.startsWith('as-0') || lower.startsWith('kt-1')) return true;

  return false;
}

async function processPhotoOCR(photo, itemName) {
  if (!shouldRunOCR(itemName)) return null;

  const ocrText = await runOCR(photo.dataUrl);
  const serialCandidates = extractSerialCandidates(ocrText);

  return { ocrText, serialCandidates };
}
