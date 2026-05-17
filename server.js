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
  'taylormade driver right hand','ping driver right hand','callaway driver right hand',
  'titleist driver right hand','cobra driver right hand','srixon driver right hand',
  'taylormade irons right hand','ping irons right hand','callaway irons right hand',
  'titleist irons right hand','mizuno irons right hand','cleveland irons right hand',
  'srixon irons right hand','scotty cameron putter','odyssey putter','ping putter',
  'taylormade putter','titleist putter','ventus shaft','fujikura shaft',
  'graphite design shaft','project x shaft','aldila shaft','oban shaft',
  'taylormade fairway wood right hand','ping fairway wood right hand','callaway fairway wood right hand',
  'golf waterproof jacket mens','golf jacket titleist','golf jacket ping',
  'golf quarter zip mens','footjoy golf jacket','under armour golf jacket',
  'golf driver','golf irons','golf putter','golf shaft','golf jacket',
  'golf clubs','golf set','golf',
];

const EXCLUDE_KEYWORDS = [
  'golf mk','golf gti','golf r ','golf tdi','golf tsi','golf 1.','golf 2.',
  'golf 1999','golf 2000','golf 2001','golf 2002','golf 2003','golf 2004',
  'golf 2005','golf 2006','golf 2007','golf 2008','golf 2009','golf 2010',
  'golf 2011','golf 2012','golf 2013','golf 2014','golf 2015','golf 2016',
  'golf 2017','golf 2018','golf 2019','golf 2020','golf 2021','golf 2022',
  'mk4','mk5','mk6','mk7','mk8',
  'gearbox','exhaust','bumper','bonnet','wing mirror','alloy wheel',
  'tyre','brake pad','engine','radiator','headlight','tailgate',
  'door panel','windscreen','alternator','cambelt','catalytic',
  'vw golf','volkswagen golf','xbox','playstation','ps4','ps5','nintendo','wii sports golf',
];

const LEFT_HAND_KEYWORDS = ['left hand','left-hand','left handed','left-handed','lh)','(lh','for lefty','lefty'];

function isExcluded(t) { const x = t.toLowerCase(); return EXCLUDE_KEYWORDS.some(k => x.includes(k)); }
function isLeftHanded(t) {
  const x = t.toLowerCase();
  const isClub = x.includes('driver') || x.includes('iron') || x.includes('putter') || x.includes('wood') || x.includes('hybrid');
  if (!isClub) return false;
  return LEFT_HAND_KEYWORDS.some(k => x.includes(k));
}

function detectFlag(title) {
  const checks = [
    ['calloway','Callaway'],['titlest','Titleist'],['drver','driver'],['puter','putter'],
    ['stif ','stiff'],['irns','irons'],['scotty camron','Scotty Cameron'],['calaway','Callaway'],
    ['fujikara','Fujikura'],['ventus blu','Ventus Blue'],['ping g 430','Ping G430'],
    ['cleavland','Cleveland'],['mizzuno','Mizuno'],
  ];
  const l = title.toLowerCase();
  for (const [w, c] of checks) if (l.includes(w)) return `Misspelling: "${w}" → "${c}"`;
  if (title === title.toLowerCase() && title.length > 10) return 'All lowercase title — poor SEO';
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

// Build a "model key" from title — used to group similar items for price comparison
// E.g. "TaylorMade Qi10 Driver 10.5° Stiff" → "taylormade qi10 driver"
function getModelKey(title) {
  const t = title.toLowerCase();
  // Common golf model patterns
  const models = [
    /\btaylormade\s+\w+\s+(driver|iron|putter|wood)/,
    /\bscotty cameron\s+\w+\s*\w*/,
    /\bping\s+g\d+\s*\w*/,
    /\bping\s+\w+\s+(driver|iron|putter)/,
    /\bcallaway\s+\w+\s*(driver|iron|putter|wood)?/,
    /\btitleist\s+\w+\s*\w*/,
    /\bmizuno\s+\w+\s*\w*/,
    /\bventus\s+(blue|red|black|tr)/,
    /\bfujikura\s+\w+/,
    /\bgraphite design\s+\w+\s*\w*/,
    /\bodyssey\s+\w+\s*\w*/,
  ];
  for (const re of models) {
    const m = t.match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  // Fallback: first 3 words
  return t.split(/\s+/).slice(0, 3).join(' ');
}

function getSoldUrl(title) {
  const c = title.split(' ').slice(0, 6).join(' ');
  return `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(c)}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1&_ipg=20&_sop=13`;
}

// Calculate deal score 0-100 based on multiple signals
function calculateDealScore(item, modelStats) {
  let score = 0;
  const reasons = [];

  // 1. Below market price — biggest factor (up to 40 pts)
  if (modelStats && modelStats.count >= 3) {
    const pctBelow = ((modelStats.avg - item.price) / modelStats.avg) * 100;
    if (pctBelow >= 40) { score += 40; reasons.push(`${Math.round(pctBelow)}% below market avg (£${modelStats.avg})`); }
    else if (pctBelow >= 25) { score += 30; reasons.push(`${Math.round(pctBelow)}% below market avg (£${modelStats.avg})`); }
    else if (pctBelow >= 15) { score += 20; reasons.push(`${Math.round(pctBelow)}% below market avg (£${modelStats.avg})`); }
    else if (pctBelow >= 5) { score += 10; reasons.push(`Slightly below average`); }
  }

  // 2. Poor title — likely undervalued (up to 20 pts)
  if (item.ai_flag) {
    score += 20;
    reasons.push(item.ai_flag);
  }

  // 3. Premium brand at low price (up to 15 pts)
  const premiumBrands = ['scotty cameron','taylormade','titleist','ping','graphite design'];
  const titleLower = item.title.toLowerCase();
  const isPremium = premiumBrands.some(b => titleLower.includes(b));
  if (isPremium && item.price < 100) { score += 15; reasons.push('Premium brand under £100'); }
  else if (isPremium && item.price < 200) { score += 8; reasons.push('Premium brand under £200'); }

  // 4. New / inexperienced seller (up to 15 pts)
  const fb = item.seller_feedback_count || 0;
  if (fb > 0 && fb < 20) { score += 15; reasons.push(`New seller (${fb} feedback)`); }
  else if (fb >= 20 && fb < 100) { score += 8; reasons.push(`Newer seller (${fb} feedback)`); }

  // 5. Free shipping bonus (5 pts)
  if (item.free_shipping) { score += 5; reasons.push('Free shipping'); }

  // 6. Bundle / set detection (10 pts)
  const bundleWords = ['set','bundle','lot of','x4','x5','x6','5-pw','4-pw','3-pw','irons set'];
  if (bundleWords.some(w => titleLower.includes(w))) { score += 10; reasons.push('Bundle/set listing'); }

  return { score: Math.min(score, 100), reasons };
}

function getDealRating(score) {
  if (score >= 75) return { label: 'HOT DEAL', color: '#ef4444' };
  if (score >= 55) return { label: 'GREAT DEAL', color: '#00ff88' };
  if (score >= 35) return { label: 'WORTH CHECK', color: '#3b82f6' };
  if (score >= 20) return { label: 'AVERAGE', color: '#f59e0b' };
  return { label: 'PASS', color: '#64748b' };
}

app.get('/api/listings', async (req, res) => {
  try {
    const token = await getAccessToken();
    const rawItems = [];
    const seen = new Set();

    // Pass 1 — fetch all listings
    for (const q of SEARCHES) {
      try {
        const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=20&filter=buyingOptions:{FIXED_PRICE},itemLocationCountry:GB,conditions:{USED|VERY_GOOD|GOOD|LIKE_NEW|NEW}&sort=newlyListed`;
        const r = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB', 'Accept-Language': 'en-GB' }
        });
        const data = await r.json();
        const list = data.itemSummaries || [];

        for (const it of list) {
          if (seen.has(it.itemId)) continue;
          seen.add(it.itemId);
          const price = parseFloat(it.price?.value || 0);
          if (price < 20) continue;
          if (it.price?.currency !== 'GBP') continue;
          if (isExcluded(it.title)) continue;
          if (isLeftHanded(it.title)) continue;
          const loc = it.itemLocation?.country || '';
          if (loc && loc !== 'GB') continue;

          const freeShip = it.shippingOptions?.[0]?.shippingCost?.value === '0.00';
          rawItems.push({
            id: it.itemId,
            title: it.title,
            sold_url: getSoldUrl(it.title),
            listed_at: it.itemCreationDate || null,
            price: Math.round(price),
            free_shipping: freeShip,
            ai_flag: detectFlag(it.title),
            marketplace: 'eBay',
            url: it.itemWebUrl,
            image_url: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
            condition: it.condition || 'Used',
            seller_rating: it.seller?.feedbackPercentage || null,
            seller_feedback_count: it.seller?.feedbackScore || null,
            category: getCategory(it.title),
            model_key: getModelKey(it.title),
          });
        }
      } catch (err) {
        console.error(`Search "${q}":`, err.message);
      }
    }

    // Pass 2 — calculate average price per model from active listings
    const modelGroups = {};
    for (const item of rawItems) {
      if (!modelGroups[item.model_key]) modelGroups[item.model_key] = [];
      modelGroups[item.model_key].push(item.price);
    }
    const modelStats = {};
    for (const [key, prices] of Object.entries(modelGroups)) {
      if (prices.length < 3) continue;
      prices.sort((a, b) => a - b);
      // Remove top and bottom 10% to filter outliers
      const trimmed = prices.slice(Math.floor(prices.length * 0.1), Math.ceil(prices.length * 0.9));
      const avg = Math.round(trimmed.reduce((s, p) => s + p, 0) / trimmed.length);
      modelStats[key] = {
        avg,
        median: prices[Math.floor(prices.length / 2)],
        min: prices[0],
        max: prices[prices.length - 1],
        count: prices.length,
      };
    }

    // Pass 3 — score each listing
    const items = rawItems.map(item => {
      const stats = modelStats[item.model_key];
      const { score, reasons } = calculateDealScore(item, stats);
      const rating = getDealRating(score);
      return {
        ...item,
        deal_score: score,
        deal_label: rating.label,
        deal_color: rating.color,
        deal_reasons: reasons,
        market_avg: stats ? stats.avg : null,
        market_count: stats ? stats.count : 0,
        pct_below: stats ? Math.round(((stats.avg - item.price) / stats.avg) * 100) : null,
      };
    });

    // Sort by deal score (highest first)
    items.sort((a, b) => b.deal_score - a.deal_score);

    console.log(`Total: ${items.length}, Hot deals: ${items.filter(i => i.deal_score >= 75).length}`);
    res.json({ success: true, listings: items.slice(0, 120) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
