const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const APP_ID = process.env.EBAY_CLIENT_ID;

const GOLF_SEARCHES = [
  'TaylorMade driver',
  'Scotty Cameron putter',
  'Titleist irons',
  'Ping driver',
  'Callaway irons',
  'Mizuno irons',
  'Ventus shaft',
  'Fujikura shaft',
  'golf waterproof jacket',
  'golf quarter zip',
];

const RESALE_MAP = {
  'taylormade': 1.9,
  'scotty cameron': 1.85,
  'titleist': 1.7,
  'ping': 1.7,
  'callaway': 1.6,
  'mizuno': 1.65,
  'ventus': 1.8,
  'fujikura': 1.75,
  'graphite design': 1.9,
  'odyssey': 1.5,
};

function estimateResale(title, price) {
  const t = title.toLowerCase();
  for (const [brand, mult] of Object.entries(RESALE_MAP)) {
    if (t.includes(brand)) return Math.round(price * mult);
  }
  return Math.round(price * 1.5);
}

function detectAIFlag(title) {
  const checks = [
    ['taylormade', 'TaylorMade'],
    ['calloway', 'Callaway'],
    ['titlest', 'Titleist'],
    ['drver', 'driver'],
    ['puter', 'putter'],
    ['stif ', 'stiff'],
    ['irns', 'irons'],
    ['scotty camron', 'Scotty Cameron'],
    ['scotty cemeron', 'Scotty Cameron'],
  ];
  const lower = title.toLowerCase();
  for (const [wrong, correct] of checks) {
    if (lower.includes(wrong)) {
      return `Misspelling: "${wrong}" → "${correct}" — likely undervalued`;
    }
  }
  if (title === title.toLowerCase() && title.length > 10) {
    return 'All lowercase title — poor SEO, may be undervalued';
  }
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
  if (t.includes('zip') || t.includes('fleece') || t.includes('pullover')) return 'Quarter Zips';
  if (t.includes('utility') || t.includes('hybrid')) return 'Utility Irons';
  return 'Other';
}

app.get('/api/listings', async (req, res) => {
  try {
    const allItems = [];
    const seen = new Set();

    for (const query of GOLF_SEARCHES) {
      const params = new URLSearchParams({
        'OPERATION-NAME': 'findItemsAdvanced',
        'SERVICE-VERSION': '1.13.0',
        'SECURITY-APPNAME': APP_ID,
        'RESPONSE-DATA-FORMAT': 'JSON',
        'REST-PAYLOAD': '',
        'keywords': query,
        'categoryId': '1513',
        'itemFilter(0).name': 'ListingType',
        'itemFilter(0).value': 'FixedPrice',
        'itemFilter(1).name': 'Condition',
        'itemFilter(1).value(0)': '3000',
        'itemFilter(1).value(1)': '2500',
        'itemFilter(1).value(2)': '2000',
        'itemFilter(1).value(3)': '1000',
        'itemFilter(2).name': 'LocatedIn',
        'itemFilter(2).value': 'GB',
        'itemFilter(3).name': 'Currency',
        'itemFilter(3).value': 'GBP',
        'sortOrder': 'StartTimeNewest',
        'paginationInput.entriesPerPage': '20',
      });

      const url = `https://svcs.ebay.com/services/search/FindingService/v1?${params}`;
      const r = await fetch(url);
      const data = await r.json();

      const items = data?.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item || [];

      for (const item of items) {
        const itemId = item.itemId?.[0];
        if (!itemId || seen.has(itemId)) continue;
        seen.add(itemId);

        const title = item.title?.[0] || '';
        const priceStr = item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'];
        const price = parseFloat(priceStr || '0');
        if (price < 10 || price > 800) continue;

        const viewUrl = item.viewItemURL?.[0] || '';
        const imageUrl = item.galleryURL?.[0] || null;
        const condition = item.condition?.[0]?.conditionDisplayName?.[0] || 'Used';
        const sellerFeedback = item.sellerInfo?.[0]?.positiveFeedbackPercent?.[0] || null;
        const shippingCost = parseFloat(item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.['__value__'] || '7');

        const resale = estimateResale(title, price);
        const fees = Math.round(resale * 0.1);
        const shipping = shippingCost > 0 ? Math.round(shippingCost) : 7;
        const profit = resale - price - fees - shipping;
        const roi = Math.round((profit / price) * 100);

        if (roi < 20) continue;

        allItems.push({
          id: itemId,
          title,
          price: Math.round(price),
          resale,
          fees,
          shipping,
          profit: Math.round(profit),
          roi,
          badge: getBadge(roi),
          hot: roi >= 40,
          ai_flag: detectAIFlag(title),
          marketplace: 'eBay',
          url: viewUrl,
          image_url: imageUrl,
          condition,
          seller_rating: sellerFeedback,
          category: getCategory(title),
          time: 0,
        });
      }
    }

    allItems.sort((a, b) => b.roi - a.roi);
    res.json({ success: true, listings: allItems });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GolfFlip running on port ${PORT}`));
