const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

let tokenCache = { token: null, expires: 0 };
const soldPriceCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

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

const MODEL_PATTERNS = [
  {regex:/\bqi10\s*(max|ls|lst)?\b/i, name:'TaylorMade Qi10 driver'},
  {regex:/\bstealth\s*2?\s*(plus|hd)?\b/i, name:'TaylorMade Stealth driver'},
  {regex:/\bsim\s*2?\s*(max|ti)?\b/i, name:'TaylorMade SIM driver'},
  {regex:/\bm[1-6]\s*(d-type)?\b/i, name:'TaylorMade M driver'},
  {regex:/\bg430\s*(max|lst|sft)?\b/i, name:'Ping G430 driver'},
  {regex:/\bg425\s*(max|lst|sft)?\b/i, name:'Ping G425 driver'},
  {regex:/\bg410\b/i, name:'Ping G410 driver'},
  {regex:/\bparadym\s*(triple|x|ai|smoke)?\b/i, name:'Callaway Paradym driver'},
  {regex:/\brogue\s*st?\b/i, name:'Callaway Rogue driver'},
  {regex:/\btsr[1-4]\b/i, name:'Titleist TSR driver'},
  {regex:/\btsi[1-4]\b/i, name:'Titleist TSi driver'},
  {regex:/\bphantom\s*(x)?\s*[0-9.]+/i, name:'Scotty Cameron Phantom putter'},
  {regex:/\bnewport\s*[0-9.]*/i, name:'Scotty Cameron Newport putter'},
  {regex:/\bspecial\s*select\b/i, name:'Scotty Cameron Special Select putter'},
  {regex:/\bmp[\s-]?20\b/i, name:'Mizuno MP-20 irons'},
  {regex:/\bjpx\s*9[0-9]+/i, name:'Mizuno JPX irons'},
  {regex:/\bventus\s*(blue|red|black|tr)\b/i, name:'Ventus shaft'},
  {regex:/\btour\s*ad\s*(iz|vr|di|hd|xc)?\b/i, name:'Graphite Design Tour AD shaft'},
];

function detectModel(title) {
  for (const p of MODEL_PATTERNS) {
    if (p.regex.test(title)) return p.name;
  }
  return null;
}

// Map eBay listing condition to URL filter code for sold listings
// 1000=New, 1500=New other, 1750=New with defects, 2000=Manufacturer refurb, 
// 2500=Seller refurb, 3000=Used, 4000=Very Good, 5000=Good, 6000=Acceptable, 7000=For parts
function getConditionCode(condition) {
  const c = (condition || '').toLowerCase();
  if (c.includes('new with') || c === 'new') return '1000';
  if (c.includes('new other')) return '1500';
  if (c.includes('open box')) return '1500';
  if (c.includes('manufacturer refurb')) return '2000';
  if (c.includes('seller refurb') || c.includes('refurbished')) return '2500';
  if (c.includes('like new') || c.includes('excellent')) return '3000';
  if (c.includes('very good')) return '4000';
  if (c.includes('good')) return '5000';
  if (c.includes('acceptable') || c.includes('fair')) return '6000';
  if (c.includes('parts') || c.includes('not working')) return '7000';
  return '3000'; // default to "Used"
}

function normaliseCondition(condition) {
  const c = (condition || '').toLowerCase();
  if (c.includes('new with') || c === 'new') return 'New';
  if (c.includes('new other')) return 'New other';
  if (c.includes('open box')) return 'Open box';
  if (c.includes('manufacturer refurb')) return 'Refurbished';
  if (c.includes('seller refurb') || c.includes('refurbished')) return 'Refurbished';
  if (c.includes('like new') || c.includes('excellent')) return 'Like New';
  if (c.includes('very good')) return 'Very Good';
  if (c.includes('good')) return 'Good';
  if (c.includes('acceptable') || c.includes('fair')) return 'Acceptable';
  if (c.includes('used')) return 'Used';
  return 'Used';
}

const FALLBACK_BRAND = {
  'taylormade':1.9,'scotty cameron':1.85,'titleist':1.7,'ping':1.7,'callaway':1.6,
  'mizuno':1.65,'ventus':1.8,'fujikura':1.75,'graphite design':1.9,'odyssey':1.5,
};

function fallbackEstimate(title, price) {
  const t = title.toLowerCase();
  for (const [b, m] of Object.entries(FALLBACK_BRAND)) if (t.includes(b)) return Math.round(price * m);
  return Math.round(price * 1.5);
}

// Fetches sold prices for an EXACT model + condition combination
async function getSoldPriceForCondition(modelName, condition) {
  const conditionCode = getConditionCode(condition);
  const cacheKey = `${modelName}|${conditionCode}`;
  
  const cached = soldPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached;
  
  try {
    // LH_ItemCondition filters by exact condition, LH_Sold=1 = completed sales only
    const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(modelName)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=${conditionCode}&_ipg=60`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'en-GB,en;q=0.9',
      }
    });
    const html = await r.text();
    
    const prices = [];
    const priceRegex = /<span class="s-item__price"[^>]*>(?:<span[^>]*>)?£([\d,]+\.\d{2})/g;
    let match;
    while ((match = priceRegex.exec(html)) !== null) {
      const p = parseFloat(match[1].replace(/,/g, ''));
      if (p > 5 && p < 5000) prices.push(p);
    }
    
    let result;
    if (prices.length < 3) {
      result = { median: null, low: null, high: null, count: 0, timestamp: Date.now() };
    } else {
      prices.sort((a, b) => a - b);
      const median = prices[Math.floor(prices.length / 2)];
      // Use 25th-75th percentile for low/high (excludes outliers)
      const q1 = prices[Math.floor(prices.length * 0.25)];
      const q3 = prices[Math.floor(prices.length * 0.75)];
      result = { 
        median: Math.round(median), 
        low: Math.round(q1),
        high: Math.round(q3),
        count: prices.length, 
        timestamp: Date.now() 
      };
      console.log(`Sold "${modelName}" [${normaliseCondition(condition)}]: ${prices.length} sales, median £${result.median} (£${result.low}-£${result.high})`);
    }
    
    soldPriceCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`Failed sold prices ${modelName}:`, err.message);
    return { median: null, low: null, high: null, count: 0, timestamp: Date.now() };
  }
}

async function estimateResale(title, price, condition) {
  const model = detectModel(title);
  
  if (model) {
    // Try exact condition first
    let soldData = await getSoldPriceForCondition(model, condition);
    let matchType = 'exact_condition';
    
    // If not enough data for that exact condition, try a less specific condition (Used)
    if (!soldData.median || soldData.count < 3) {
      soldData = await getSoldPriceForCondition(model, 'used');
      matchType = 'used_condition';
    }
    
    if (soldData.median && soldData.count >= 3) {
      return {
        resale: soldData.median,
        source: 'sold_data',
        match_type: matchType,
        model,
        condition_matched: normaliseCondition(condition),
        sold_median: soldData.median,
        sold_low: soldData.low,
        sold_high: soldData.high,
        sold_count: soldData.count,
      };
    }
  }
  
  return {
    resale: fallbackEstimate(title, price),
    source: 'brand_multiplier',
    match_type: 'fallback',
    model: null,
    condition_matched: normaliseCondition(condition),
    sold_median: null,
    sold_low: null,
    sold_high: null,
    sold_count: 0,
  };
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
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=20&filter=buyingOptions:{FIXED_PRICE}&sort=newlyListed`;
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
        
        const condition = it.condition || 'Used';
        const resaleData = await estimateResale(it.title, price, condition);
        
        const fees = Math.round(resaleData.resale * 0.1);
        const shipping = 7;
        const profit = resaleData.resale - price - fees - shipping;
        const roi = Math.round((profit / price) * 100);
        if (roi < 15) continue;
        
        items.push({
          id: it.itemId,
          title: it.title,
          listed_at: it.itemCreationDate || null,
          price: Math.round(price),
          resale: resaleData.resale,
          resale_source: resaleData.source,
          match_type: resaleData.match_type,
          model_detected: resaleData.model,
          condition_matched: resaleData.condition_matched,
          sold_median: resaleData.sold_median,
          sold_low: resaleData.sold_low,
          sold_high: resaleData.sold_high,
          sold_count: resaleData.sold_count,
          fees, shipping,
          profit: Math.round(profit),
          roi,
          badge: getBadge(roi),
          hot: roi >= 40,
          ai_flag: detectFlag(it.title),
          marketplace: 'eBay',
          url: it.itemWebUrl,
          image_url: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
          condition,
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
