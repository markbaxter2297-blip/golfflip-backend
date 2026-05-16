const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

let tokenCache = { token: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  const data = await r.json();
  console.log('TOKEN RESPONSE:', JSON.stringify(data));
  
  if (!data.access_token) throw new Error('No token: ' + JSON.stringify(data));
  
  tokenCache.token = data.access_token;
  tokenCache.expires = Date.now() + (data.expires_in - 60) * 1000;
  return tokenCache.token;
}

app.get('/api/listings', async (req, res) => {
  try {
    const token = await getAccessToken();
    
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=taylormade%20driver&limit=20&filter=buyingOptions:{FIXED_PRICE}';
    
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
        'Accept': 'application/json',
      }
    });
    
    const data = await r.json();
    console.log('EBAY RESPONSE:', JSON.stringify(data).substring(0, 500));
    
    res.json({ 
      success: true, 
      raw: data,
      itemCount: data.itemSummaries?.length || 0,
    });
    
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GolfFlip running on port ${PORT}`));
