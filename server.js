const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const GOLF_SEARCHES = [
  'TaylorMade driver',
  'Scotty Cameron putter',
  'Titleist irons',
  'Ping driver',
  'Callaway irons',
  'Mizuno irons',
  'Ventus shaft',
  'golf waterproof jacket',
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
    ['calloway', 'Callaway'],
    ['titlest', 'Titleist'],
    ['drver', 'driver'],
    ['puter', 'putter'],
    ['stif ', 'stiff'],
    ['irns', 'irons'],
    ['scotty camron', 'Scotty Cameron'],
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
  if (t.includes('zip') || t.includes('fleece')) return 'Quarter Zips';
  if (t.includes('utility') || t.includes('hybrid')) return 'Utility Irons';
  return 'Other';
}

async function scrapeEbaySearch(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encoded}&_sop=10&LH_BIN=1&_ipg=60`;
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-GB,en;q=0.9',
    }
  });
  const html = await res.text();
  
  const items = [];
  const itemRegex = /<li class="s-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  
  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[1];
    
    const titleMatch = block.match(/<span[^>]*role="heading"[^>]*>([^<]+)<\/span>/) 
                    || block.match(/<div class="s-item__title"[^>]*>(?:<span[^>]*>)?([^<]+)/);
    const priceMatch = block.match(/<span class="s-item__price"[^>]*>(?:<span[^>]*>)?£([\d,]+\.\d{2})/);
    const urlMatch = block.match(/<a class="s-item__link"[^>]*href="([^"]+)"/);
    const imgMatch = block.match(/<img[^>]*src="([^"]+)"[^>]*class="s-item__image-img/) 
                  || block.match(/<img[^>]*class="s-item__image-img"[^>]*src="([^"]+)"/);
    const condMatch = block.match(/<span class="SECONDARY_INFO"[^>]*>([^<]+)<\/span>/);
    const itemIdMatch = urlMatch ? urlMatch[1].match(/\/itm\/(?:[^\/]+\/)?(\d+)/) : null;
    
    if (!titleMatch || !priceMatch || !urlMatch || !itemIdMatch) continue;
    
    const title = titleMatch[1].trim();
    if (title.toLowerCase().includes('shop on ebay')) continue;
    
    const price = parseFloat(priceMatch[1].replace(/,/g, ''));
    if (price < 5 || price > 1500) continue;
    
    items.push({
      itemId: itemIdMatch[1],
      title,
      price,
      url: urlMatch[1].split('?')[0],
      image: imgMatch ? imgMatch[1] : null,
      condition: condMatch ? condMatch[1].trim() : 'Used',
    });
  }
  
  return items;
}

app.get('/api/listings', async (req, res) => {
  try {
    const allItems = [];
    const seen = new Set();
    
    for (const query of GOLF_SEARCHES) {
      try {
        console.log('Scraping:', query);
        const items = await scrapeEbaySearch(query);
        console.log(`  Found ${items.length} items`);
        
        for (const item of items) {
          if (seen.has(item.itemId)) continue;
          seen.add(item.itemId);
          
          const resale = estimateResale(item.title, item.price);
          const fees = Math.round(resale * 0.1);
          const shipping = 7;
          const profit = resale - item.price - fees - shipping;
          const roi = Math.round((profit / item.price) * 100);
          
          if (roi < 15) continue;
          
          allItems.push({
            id: item.itemId,
            title: item.title,
            price: Math.round(item.price),
            resale,
            fees,
            shipping,
            profit: Math.round(profit),
            roi,
            badge: getBadge(roi),
            hot: roi >= 40,
            ai_flag: detectAIFlag(item.title),
            marketplace: 'eBay',
            url: item.url,
            image_url: item.image,
            condition: item.condition,
            seller_rating: null,
            category: getCategory(item.title),
            time: 0,
          });
        }
      } catch (err) {
        console.error(`Error scraping "${query}":`, err.message);
      }
    }
    
    allItems.sort((a, b) => b.roi - a.roi);
    console.log(`Returning ${allItems.length} total listings`);
    res.json({ success: true, listings: allItems.slice(0, 60) });
    
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GolfFlip running on port ${PORT}`));
