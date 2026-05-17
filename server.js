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
  // Drivers
  'taylormade driver right hand',
  'ping driver right hand',
  'callaway driver right hand',
  'titleist driver right hand',
  'cobra driver right hand',
  'srixon driver right hand',
  // Irons
  'taylormade irons right hand',
  'ping irons right hand',
  'callaway irons right hand',
  'titleist irons right hand',
  'mizuno irons right hand',
  'cleveland irons right hand',
  'srixon irons right hand',
  // Putters
  'scotty cameron putter',
  'odyssey putter',
  'ping putter',
  'taylormade putter',
  'titleist putter',
  // Shafts
  'ventus shaft',
  'fujikura shaft',
  'graphite design shaft',
  'project x shaft',
  'aldila shaft',
  'oban shaft',
  // Fairway & Hybrids
  'taylormade fairway wood right hand',
  'ping fairway wood right hand',
  'callaway fairway wood right hand',
  // Clothing
  'golf waterproof jacket mens',
  'golf jacket titleist',
  'golf jacket ping',
  'golf quarter zip mens',
  'footjoy golf jacket',
  'under armour golf jacket',
  // Broad
  'golf driver',
  'golf irons',
  'golf putter',
  'golf shaft',
  'golf jacket',
  'golf clubs',
  'golf set',
  'golf',
];

const LEFT_HAND_KEYWORDS = [
  'left hand','left-hand','left handed','left-handed',
  'lh)','(lh','for lefty','lefty',
];

function isLeftHanded(title) {
  const t = title.toLowerCase();
  const isClub = t.includes('driver') || t.includes('iron') || t.includes('putter') ||
                 t.includes('wood') || t.includes('hybrid') || t.includes('utility');
  if (!isClub) return false;
  return LEFT_HAND_KEYWORDS.some(kw => t.includes(kw));
}

function detectFlag(title) {
  const checks = [
    ['calloway','Callaway'],['titlest','Titleist'],['drver','driver'],
    ['puter','putter'],['stif ','stiff'],['irns','irons'],
    ['scotty camron','Scotty Cameron'],['taylormade','TaylorMade'],
    ['calaway','Callaway'],['fujikara','Fujikura'],
    ['ventus blu','Ventus Blue'],['ping g 430','Ping G430'],
    ['cleavland','Cleveland'],['mizzuno','Mizuno'],
  ];
  const l = title.toLowerCase();
  for (const [w, c] of checks) if (l.includes(w)) return `Misspelling: "${w}" → "${c}" — may be undervalued`;
  if (title === title.toLowerCase() && title.length > 10) return 'All lowercase title — poor SEO, may be undervalued';
  return null;
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
  return 'Golf';
}

function getSoldUrl(title) {
  const cleanTitle = title.split(' ').slice(0, 6).join(' ');
  return `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(cleanTitle)}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1&_ipg=20&_sop=13`;
}

app.get('/api/listings', async (req, res) => {
  try {
    const token = await getAccessToken();
    const items = [];
    const seen = new Set();

    for (const q of SEARCHES) {
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
          if (price < 20) continue;
          if (it.price?.currency !== 'GBP') continue;
          if (isLeftHanded(it.title)) continue;

          const itemLocation = it.itemLocation?.country || '';
          if (itemLocation && itemLocation !== 'GB') continue;

          const freeShip = it.shippingOptions?.[0]?.shippingCost?.value === '0.00';

          items.push({
            id: it.itemId,
            title: it.title,
            sold_url: getSoldUrl(it.title),
            listed_at: it.itemCreationDate || null,
            price: Math.round(price),
            free_shipping: freeShip,
            shipping_cost: freeShip ? 0 : parseFloat(it.shippingOptions?.[0]?.shippingCost?.value || 7),
            ai_flag: detectFlag(it.title),
            marketplace: 'eBay',
            url: it.itemWebUrl,
            image_url: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
            condition: it.condition || 'Used',
            seller_rating: it.seller?.feedbackPercentage || null,
            seller_feedback_count: it.seller?.feedbackScore || null,
            category: getCategory(it.title),
            hot: !!detectFlag(it.title),
          });
        }
      } catch(err) {
        console.error(`Search error "${q}":`, err.message);
      }
    }

    items.sort((a, b) => {
      const at = a.listed_at ? new Date(a.listed_at).getTime() : 0;
      const bt = b.listed_at ? new Date(b.listed_at).getTime() : 0;
      return bt - at;
    });

    console.log(`Total listings: ${items.length}`);
    res.json({ success: true, listings: items.slice(0, 100) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
