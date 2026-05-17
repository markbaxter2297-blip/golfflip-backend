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
  'taylormade driver right hand',
  'ping driver right hand',
  'callaway driver right hand',
  'titleist driver right hand',
  'cobra driver right hand',
  'srixon driver right hand',
  'taylormade irons right hand',
  'ping irons right hand',
  'callaway irons right hand',
  'titleist irons right hand',
  'mizuno irons right hand',
  'cleveland irons right hand',
  'srixon irons right hand',
  'scotty cameron putter',
  'odyssey putter',
  'ping putter',
  'taylormade putter',
  'titleist putter',
  'ventus shaft',
  'fujikura shaft',
  'graphite design shaft',
  'project x shaft',
  'aldila shaft',
  'oban shaft',
  'taylormade fairway wood right hand',
  'ping fairway wood right hand',
  'callaway fairway wood right hand',
  'golf waterproof jacket mens',
  'golf jacket titleist',
  'golf jacket ping',
  'golf quarter zip mens',
  'footjoy golf jacket',
  'under armour golf jacket',
  'golf driver',
  'golf irons',
  'golf putter',
  'golf shaft',
  'golf jacket',
  'golf clubs',
  'golf set',
  'golf',
];

const EXCLUDE_KEYWORDS = [
  // VW Golf car specific
  'golf mk','golf gti','golf r ','golf tdi','golf tsi','golf 1.','golf 2.',
  'golf 1999','golf 2000','golf 2001','golf 2002','golf 2003','golf 2004',
  'golf 2005','golf 2006','golf 2007','golf 2008','golf 2009','golf 2010',
  'golf 2011','golf 2012','golf 2013','golf 2014','golf 2015','golf 2016',
  'golf 2017','golf 2018','golf 2019','golf 2020','golf 2021','golf 2022',
  'mk4','mk5','mk6','mk7','mk8',
  // Car parts
  'gearbox','exhaust','bumper','bonnet','wing mirror','alloy wheel',
  'tyre','brake pad','engine','radiator','headlight','tailgate',
  'door panel','windscreen','alternator','cambelt','catalytic',
  // Other vehicles
  'vw golf','volkswagen golf',
  // Gaming
  'xbox','playstation','ps4','ps5','nintendo','wii sports golf',
];

const LEFT_HAND_KEYWORDS = [
  'left hand','left-hand','left handed','left-handed',
  'lh)','(lh','for lefty','lefty',
];

function isExcluded(title) {
  const t = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => t.includes(kw));
}

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
          if
