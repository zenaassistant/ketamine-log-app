import { SignJWT } from 'jose';
import { createPrivateKey } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { data } = req.body;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  let serviceAccountKey = {};
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
    serviceAccountKey = JSON.parse(raw);
  } catch (parseErr) {
    console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:', parseErr.message);
    return res.status(500).json({ error: 'Service account key is misconfigured.' });
  }

  if (!sheetId || !serviceAccountKey.client_email) {
    return res.status(500).json({ error: 'Google Sheets not configured. Missing GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_KEY.' });
  }

  try {
    const token = await getAccessToken(serviceAccountKey);

    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const row = [
      timestamp,
      data.usageDate || '',
      data.clinician || '',
      data.client || '',
      data.sessionNumber || '',
      data.modality || '',
      data.dosage || '',
      data.lotNumber || '',
      data.notes || '',
      data.wasteOccurred || 'No waste',
      data.amountWasted || '',
      data.witnessName || '',
      data.disposalMethod || '',
      data.newVialOpened || 'No',
      data.newVialLotNumber || '',
      data.vialsRemaining || ''
    ];

    await appendRowWithRetry(sheetId, token, row);

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Failed to write to Google Sheet: ' + err.message });
  }
}

// Google Sheets occasionally returns a transient 503/429 with no fault of
// ours; retry those with backoff instead of failing the clinician's
// submission outright. Real config errors (401/403/400) fail fast.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000, 2000];

async function appendRowWithRetry(sheetId, token, row) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let sheetResponse;
    try {
      sheetResponse = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Form%20Responses!A:P:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values: [row] })
        }
      );
    } catch (networkErr) {
      // fetch itself threw (DNS/connection failure) — worth retrying.
      lastErr = networkErr;
      if (attempt === MAX_ATTEMPTS) throw lastErr;
      console.warn(`Sheets API request failed, retrying (attempt ${attempt}/${MAX_ATTEMPTS}):`, networkErr.message);
      await new Promise(resolve => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
      continue;
    }

    if (sheetResponse.ok) return;

    const errText = await sheetResponse.text();
    lastErr = new Error(errText);

    if (!RETRYABLE_STATUS.has(sheetResponse.status) || attempt === MAX_ATTEMPTS) {
      console.error('Sheets API error:', errText);
      throw lastErr;
    }

    console.warn(`Sheets API returned ${sheetResponse.status}, retrying (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    await new Promise(resolve => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
  }

  throw lastErr;
}

async function getAccessToken(serviceAccount) {
  const privateKey = createPrivateKey(serviceAccount.private_key);
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })
    .setProtectedHeader({ alg: 'RS256' })
    .sign(privateKey);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Could not get access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}
