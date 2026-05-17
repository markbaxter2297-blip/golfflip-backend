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

const CLUB_SEARCHES = [
  'taylormade driver right hand',
  'taylormade irons right hand',
  'scotty cameron putter',
  'ping driver right hand',
  'ping irons right hand',
  'callaway driver right hand',
  'callaway irons right hand',
  'titleist irons right hand',
  'titleist driver right hand',
  'mizuno irons right hand',
  'cleveland irons right hand',
  'srixon irons right hand',
  'cobra driver right hand',
  'odyssey putter',
  'ping putter',
  'taylormade putter',
];

const SHAFT_SEARCHES = [
  'ventus shaft',
  'fujikura shaft',
  'graphite design tour ad shaft',
  'project x shaft',
  'aldila shaft',
  'oban shaft',
  'accra shaft',
];

const CLOTHING_SEARCHES = [
  'golf waterproof jacket mens',
  'golf jacket titleist mens',
  'golf jacket ping mens',
  'golf quarter zip mens',
  'golf pullover mens',
  'under armour golf jacket',
  'footjoy golf jacket',
];

const ALL_SEARCHES = [...CLUB_SEARCHES, ...SHAFT_SEARCHES, ...CLOTHING_SEARCHES];

const LEFT_HAND_KEYWORDS = [
  'left hand','left-hand','lh ','lh)','(lh','left handed','left-handed',
  ' lhf ',' lh ',' lhg ','lhc','for lefty','lefty',
];

const EXCLUDE_LOCATION_KEYWORDS = [
  'ships from usa','ships from us','ships from japan','ships from korea',
  'ships from australia','international shipping only',
];

function isLeftHanded(title) {
  const t = title.toLowerCase();
  const isClub = t.includes('driver') || t.includes('iron') || t.includes('putter') ||
                 t.includes('wood') || t.includes('hybrid') || t.includes('utility');
  if (!isClub) return false;
  return LEFT_HAND_KEYWORDS.some(kw => t.includes(kw));
}

function isExcludedLocation(title) {
  const t = title.toLowerCase();
  return EXCLUDE_LOCATION_KEYWORDS.some(kw => t.includes(kw));
}

const RESALE = {
  'taylormade':1.9,'scotty cameron':1.85,'titleist':1.7,'ping':1.7,'callaway':1.6,
  'mizuno':1.65,'ventus':1.8,'fujikura':1.75,'graphite design':1.9,'odyssey':1.5,
  'cleveland':1.5,'srixon':1.45,'cobra':1.55,'project x':1.7,'aldila':1.6,
  'oban':1.65,'accra':1.6,'footjoy':1.5,'under armour':1.4,
};

function estimateResale(title, price) {
  const t = title.toLowerCase();
  for (const [b, m] of Object.entries(RESALE)) if (t.includes(b)) return Math.round(price * m);
  return Math.round(price * 1.5);
}

function detectFlag(title) {
  const checks = [
    ['calloway','Callaway'],['titlest','Titleist'],['drver','driver'],
    ['puter','putter'],['stif ','stiff'],['irns','irons'],
    ['scotty camron','Scotty Cameron'],['taylormade','TaylorMade'],
    ['ping g 430','Ping G430'],['calaway','Callaway'],
    ['fujikara','Fujikura'],['ventus blu','Ventus Blue'],
  ];
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
  if (t.includes('zip') || t.includes('fleece') || t.includes('pullover')) return 'Quarter Zips';
  if (t.includes('utility') || t.includes('hybrid')) return 'Utility Irons';
  if (t.includes('wood') || t.includes('fairway')) return 'Fairway Woods';
  return 'Other';
}

function getSoldUrl(title) {
  // Take first 5 words of title for a clean search
  const cleanTitle = title.split(' ').slice(0, 5).join(' ');
  return `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(cleanTitle)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=3000&_ipg=20&_sop=13`;
}

app.get('/api/listings', async (req, res) => {
  try {
    const token = await getAccessToken();
    const items = [];
    const seen = new Set();

    for (const q of ALL_SEARCHES) {
      try {
        const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=20&filter=buyingOptions:{FIXED_PRICE},itemLocationCountry:GB,conditions:{USED|VERY_GOOD|GOOD|LIKE_NEW|NEW}&sort=newlyListed`;

        const r = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
            'Accept-Language': 'en-GB',
          }
        });
        const data = await r.json();
        const list = data.itemSummaries || [];

        for (const it of list) {
          if (seen.has(it.itemId)) continue;
          seen.add(it.itemId);

          const price = parseFloat(it.price?.value || 0);
          if (price < 10 || price > 1200) continue;
          if (it.price?.currency !== 'GBP') continue;

          if (isLeftHanded(it.title)) continue;
          if (isExcludedLocation(it.title)) continue;

          const itemLocation = it.itemLocation?.country || '';
          if (itemLocation && itemLocation !== 'GB') continue;

          const resale = estimateResale(it.title, price);
          const fees = Math.round(resale * 0.1);
          const shipping = it.shippingOptions?.[0]?.shippingCost?.value === '0.00' ? 0 : 7;
          const profit = resale - price - fees - shipping;
          const roi = Math.round((profit / price) * 100);
          if (roi < 15) continue;

          items.push({
            id: it.itemId,
            title: it.title,
            sold_url: getSoldUrl(it.title),
            listed_at: it.itemCreationDate || null,
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
            free_shipping: it.shippingOptions?.[0]?.shippingCost?.value === '0.00',
          });
        }
      } catch(err) {
        console.error(`Search error for "${q}":`, err.message);
      }
    }

    items.sort((a, b) => b.roi - a.roi);
    console.log(`Total listings: ${items.length}`);
    res.json({ success: true, listings: items.slice(0, 80) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
