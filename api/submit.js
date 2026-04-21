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

    const sheetResponse = await fetch(
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

    if (!sheetResponse.ok) {
      const errText = await sheetResponse.text();
      console.error('Sheets API error:', errText);
      throw new Error(errText);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Failed to write to Google Sheet: ' + err.message });
  }
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
