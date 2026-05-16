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
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Token failed: ' + JSON.stringify(data));
  tokenCache.token = data.access_token;
  tokenCache.expires = Date.now() + (data.expires_in - 60) * 1000;
  return tokenCache.token;
}

const SEARCHES = [
  'taylormade driver','scotty cameron putter','titleist irons','ping driver','callaway irons',
  'mizuno irons','ventus shaft','fujikura shaft','golf waterproof jacket','golf quarter zip',
];

const RESALE = {
  'taylormade':1.9,'scotty cameron':1.85,'titleist':1.7,'ping':1.7,'callaway':1.6,
  'mizuno':1.65,'ventus':1.8,'fujikura':1.75,'graphite design':1.9,'odyssey':1.5,
};

function estimateResale(title, price) {
  const t = title.toLowerCase();
  for (const [b, m] of Object.entries(RESALE)) if (t.includes(b)) return Math.round(price * m);
  return Math.round(price * 1.5);
}

function detectFlag(title) {
  const checks = [['calloway','Callaway'],['titlest','Titleist'],['drver','driver'],
    ['puter','putter'],['stif ','stiff'],['irns','irons'],['scotty camron','Scotty Cameron']];
  const l = title.toLowerCase();
  for (const [w, c] of checks) if (l.includes(w)) return `Misspelling: "${w}" → "${c}" — likely undervalued`;
  if (title === title.toLowerCase() && title.length > 10) return 'All lowercase — poor SEO, may be undervalued';
  return null;
}

function getBadge(roi) {
  if (roi >= 60) return 'Excellent Deal';
  if (roi >= 40) return 'Good Margin';
  if (roi >= 25) return 'Fast Seller';
  return 'Watch';
}

function getCategory(title) {
  const t = title.toLowerCase();
  if (t.includes('driver')) return 'Drivers';
  if (t.includes('iron')) return 'Iron Sets';
  if (t.includes('putter') || t.includes('puter')) return 'Putters';
  if (t.includes('shaft')) return 'Premium Shafts';
  if (t.includes('jacket') || t.includes('waterproof')) return 'Golf Jackets';
  if (t.includes('zip') || t.includes('fleece')) return 'Quarter Zips';
  if (t.includes('utility') || t.includes('hybrid')) return 'Utility Irons';
  return 'Other';
}

app.get('/api/listings', async (req, res) => {
  try {
    const token = await getAccessToken();
    const items = [];
    const seen = new Set();
    
    for (const q of SEARCHES) {
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=20&filter=buyingOptions:{FIXED_PRICE}`;
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
      });
      const data = await r.json();
      const list = data.itemSummaries || [];
      
      for (const it of list) {
        if (seen.has(it.itemId)) continue;
        seen.add(it.itemId);
        const price = parseFloat(it.price?.value || 0);
        if (price < 10 || price > 1200) continue;
        if (it.price?.currency !== 'GBP') continue;
        
        const resale = estimateResale(it.title, price);
        const fees = Math.round(resale * 0.1);
        const shipping = 7;
        const profit = resale - price - fees - shipping;
        const roi = Math.round((profit / price) * 100);
        if (roi < 15) continue;
        
        items.push({
          id: it.itemId,
          title: it.title,
          price: Math.round(price),
          resale, fees, shipping,
          profit: Math.round(profit),
          roi,
          badge: getBadge(roi),
          hot: roi >= 40,
          ai_flag: detectFlag(it.title),
          marketplace: 'eBay',
          url: it.itemWebUrl,
          image_url: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
          condition: it.condition || 'Used',
          seller_rating: it.seller?.feedbackPercentage || null,
          category: getCategory(it.title),
          time: 0,
        });
      }
    }
    items.sort((a, b) => b.roi - a.roi);
    res.json({ success: true, listings: items.slice(0, 60) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
