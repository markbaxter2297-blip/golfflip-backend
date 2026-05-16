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
  if (tokenCache.token && Date.now() < tokenCache.expires) {
    return tokenCache.token;
  }
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  const data = await res.json();
  tokenCache.token = data.access_token;
  tokenCache.expires = Date.now() + (data.expires_in - 60) * 1000;
  return tokenCache.token;
}

const GOLF_SEARCHES = [
  'TaylorMade driver',
  'Scotty Cameron putter',
  'Titleist irons',
  'Ping driver',
  'Callaway irons',
  'Mizuno irons',
  'Ventus shaft',
  'Fujikura shaft',
  'golf jacket',
  'golf quarter zip',
];

const RESALE_ESTIMATES = {
  'TaylorMade': 1.9,
  'Scotty Cameron': 1.8,
  'Titleist': 1.7,
  'Ping': 1.7,
  'Callaway': 1.6,
  'Mizuno': 1.6,
  'Ventus': 1.8,
  'Fujikura': 1.7,
  'Graphite Design': 1.9,
  'Odyssey': 1.5,
};

function estimateResale(title, price) {
  for (const [brand, multiplier] of Object.entries(RESALE_ESTIMATES)) {
    if (title.toLowerCase().includes(brand.toLowerCase())) {
      return Math.round(price * multiplier);
    }
  }
  return Math.round(price * 1.5);
}

function detectAIFlag(title) {
  const misspellings = [
    ['taylormade', 'TaylorMade'],
    ['scotty camron', 'Scotty Cameron'],
    ['scotty cemeron', 'Scotty Cameron'],
    ['calloway', 'Callaway'],
    ['titlest', 'Titleist'],
    ['drver', 'driver'],
    ['puter', 'putter'],
    ['stif', 'stiff'],
    ['irns', 'irons'],
    ['qi10', 'Qi10 (check spelling)'],
  ];
  const lower = title.toLowerCase();
  for (const [wrong, correct] of misspellings) {
    if (lower.includes(wrong)) {
      return `Misspelling detected: "${wrong}" → "${correct}" — likely undervalued`;
    }
  }
  if (title === title.toLowerCase()) {
    return 'Poor title formatting — all lowercase, may be undervalued';
  }
  return null;
}

function getBadge(roi) {
  if (roi >= 60) return 'Excellent Deal';
  if (roi >= 40) return 'Good Margin';
  if (roi >= 25) return 'Fast Seller';
  return 'Watch';
}

function getCategoryFromTitle(title) {
  const t = title.toLowerCase();
  if (t.includes('driver')) return 'Drivers';
  if (t.includes('iron')) return 'Iron Sets';
  if (t.includes('putter') || t.includes('puter')) return 'Putters';
  if (t.includes('shaft')) return 'Premium Shafts';
  if (t.includes('jacket')) return 'Golf Jackets';
  if (t.includes('zip') || t.includes('fleece')) return 'Quarter Zips';
  if (t.includes('utility') || t.includes('hybrid')) return 'Utility Irons';
  return 'Other';
}

app.get('/api/listings', async (req, res) => {
  try {
    const token = await getAccessToken();
    const allItems = [];
    const seen = new Set();

    const searches = GOLF_SEARCHES.slice(0, 5);

    for (const query of searches) {
      const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
      url.searchParams.set('q', query);
      url.searchParams.set('category_ids', '1513');
      url.searchParams.set('filter', 'itemLocationCountry:GB,conditions:{USED|VERY_GOOD|GOOD|LIKE_NEW}');
      url.searchParams.set('sort', 'newlyListed');
      url.searchParams.set('limit', '10');

      const r = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
      });
      const data = await r.json();

      if (!data.itemSummaries) continue;

      for (const item of data.itemSummaries) {
        if (seen.has(item.itemId)) continue;
        seen.add(item.itemId);

        const price = parseFloat(item.price?.value || 0);
        if (price < 10 || price > 800) continue;

        const resale = estimateResale(item.title, price);
        const fees = Math.round(resale * 0.1);
        const shipping = 7;
        const profit = resale - price - fees - shipping;
        const roi = Math.round((profit / price) * 100);
        if (roi < 20) continue;

        const badge = getBadge(roi);
        const aiFlag = detectAIFlag(item.title);

        allItems.push({
          id: item.itemId,
          title: item.title,
          price: Math.round(price),
          resale,
          fees,
          shipping,
          profit: Math.round(profit),
          roi,
          badge,
          hot: roi >= 40,
          ai_flag: aiFlag,
          marketplace: 'eBay',
          url: item.itemWebUrl,
          image_url: item.image?.imageUrl || null,
          condition: item.condition || 'Used',
          seller_rating: item.seller?.feedbackPercentage || null,
          category: getCategoryFromTitle(item.title),
          time: 0,
        });
      }
    }

    allItems.sort((a, b) => b.roi - a.roi);
    res.json({ success: true, listings: allItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GolfFlip backend running on port ${PORT}`));
