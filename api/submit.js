export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { data } = req.body;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');

  if (!sheetId || !serviceAccountKey.client_email) {
    return res.status(500).json({ error: 'Google Sheets not configured yet. Contact your administrator.' });
  }

  try {
    // Get access token using service account JWT
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

    const response = await fetch(
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

    if (!response.ok) {
      const err = await response.text();
      throw new Error(err);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sheets error:', err);
    res.status(500).json({ error: 'Failed to write to Google Sheet: ' + err.message });
  }
}

async function getAccessToken(serviceAccount) {
  const { SignJWT } = await import('jose');
  const { createPrivateKey } = await import('crypto');

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
  return tokenData.access_token;
}
