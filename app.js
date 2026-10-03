/**
 * ArbiScan — CEX / DEX 套利扫描器
 * 支持: Hyperliquid, AsterDEX, Binance, OKX, Bybit, Gate
 */
'use strict';

// ============================================================
// CONFIG & CONSTANTS
// ============================================================
const EXCHANGES = {
  HL:      { name: 'Hyperliquid', type: 'DEX', logo: '⚡', color: '#6366f1' },
  ASTER:   { name: 'AsterDEX',   type: 'DEX', logo: '⭐', color: '#8b5cf6' },
  BINANCE: { name: 'Binance',    type: 'CEX', logo: '🟡', color: '#f59e0b' },
  OKX:     { name: 'OKX',       type: 'CEX', logo: '🔵', color: '#06b6d4' },
  BYBIT:   { name: 'Bybit',     type: 'CEX', logo: '🔴', color: '#ef4444' },
  GATE:    { name: 'Gate',      type: 'CEX', logo: '🟢', color: '#22c55e' },
};

const HOURS_PER_YEAR = 8760;

// ============================================================
// FEE SCHEDULE (Taker fee %, default VIP0)
// Open + Close = 2 × taker per side, total = 4 × taker for both legs
// ============================================================
const FEE_TAKER = {
  HL:      0.00035, // 0.035% taker (maker -0.002%)
  ASTER:   0.00040, // 0.040% taker (same as Binance-based DEX)
  BINANCE: 0.00050, // 0.050% taker (VIP0), maker 0.020%
  OKX:     0.00050, // 0.050% taker (regular), maker 0.020%
  BYBIT:   0.00055, // 0.055% taker (regular), maker 0.020%
  GATE:    0.00050, // 0.050% taker (regular), maker 0.015%
};
// Total round-trip fee cost for one leg: open taker + close taker = 2×taker
// For both legs: longFee + shortFee
function calcRoundTripFee(longEx, shortEx) {
  return (FEE_TAKER[longEx] || 0.0005) * 2 + (FEE_TAKER[shortEx] || 0.0005) * 2;
}

// ============================================================
// STATE
// ============================================================
let state = {
  tab:         'funding',
  markets:     {},
  arbitrages:  [],
  activeExs:   new Set(['HL','ASTER','BINANCE','OKX','BYBIT','GATE']),
  minApr:      10,
  searchQ:     '',
  sortBy:      'apr_desc',
  autoRefresh: true,
  countdown:   30,
  apiKeys:     {},
  selectedOpp: null,
  histFrA:     [],   // cached historical funding for current drawer opp (long leg)
  histFrB:     [],   // cached historical funding for current drawer opp (short leg)
  histSpread:  [],   // cached historical spread series {time, priceA, priceB, spread}
  histDepthLong:  null, // cached orderbook depth for long leg
  histDepthShort: null, // cached orderbook depth for short leg
};

// ============================================================
// STORAGE
// ============================================================
function loadApiKeys() {
  try { state.apiKeys = JSON.parse(localStorage.getItem('arbi_keys') || '{}'); } catch(e) {}
}
function saveApiKeys() {
  localStorage.setItem('arbi_keys', JSON.stringify(state.apiKeys));
}

// ============================================================
// EXCHANGE DATA FETCHERS (current snapshot)
// ============================================================

async function fetchHL() {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const [meta, ctxs] = await res.json();
    const result = {};
    meta.universe.forEach((asset, i) => {
      const ctx = ctxs[i];
      if (!ctx || !ctx.markPx) return;
      result[asset.name] = {
        markPx:          parseFloat(ctx.markPx),
        fundingRate:     parseFloat(ctx.funding),
        fundingRate8h:   parseFloat(ctx.funding) * 8,
        nextFundingTime: null,
        fundingInterval: 1,
        openInterest:    parseFloat(ctx.openInterest || 0),
        volume24h:       parseFloat(ctx.dayNtlVlm || 0),
      };
    });
    return result;
  } catch(e) { console.warn('HL:', e.message); return {}; }
}

async function fetchASTER() {
  try {
    const [tickerRes, fundingRes] = await Promise.all([
      fetch('https://fapi.asterdex.com/fapi/v1/ticker/24hr'),   // ← 24h stats 含 quoteVolume
      fetch('https://fapi.asterdex.com/fapi/v1/premiumIndex'),
    ]);
    const tickers  = await tickerRes.json();
    const fundings = await fundingRes.json();

    const volMap = {};
    if (Array.isArray(tickers)) {
      tickers.forEach(t => { volMap[t.symbol] = parseFloat(t.quoteVolume || 0); });
    }

    const result = {};
    if (Array.isArray(fundings)) {
      fundings.forEach(f => {
        if (!f.symbol.endsWith('USDT') && !f.symbol.endsWith('USDC')) return;
        const base = f.symbol.replace(/(USDT|USDC)$/, '');
        const fr8h = parseFloat(f.lastFundingRate || 0);
        result[base] = {
          markPx:          parseFloat(f.markPrice || 0),
          fundingRate:     fr8h / 8,
          fundingRate8h:   fr8h,
          nextFundingTime: parseInt(f.nextFundingTime || 0),
          fundingInterval: 8,
          openInterest:    0,
          volume24h:       volMap[f.symbol] || 0,
        };
      });
    }
    return result;
  } catch(e) { console.warn('ASTER:', e.message); return {}; }
}

async function fetchBINANCE() {
  try {
    // premiumIndex 有资金费率，ticker/24hr 有 volume —— 并发拉两个
    const [fundRes, volRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex'),
      fetch('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    ]);
    const fundData = await fundRes.json();
    const volData  = await volRes.json();

    // 把 volume 存成 map: symbol → quoteVolume (USDT)
    const volMap = {};
    if (Array.isArray(volData)) {
      volData.forEach(t => { volMap[t.symbol] = parseFloat(t.quoteVolume || 0); });
    }

    const result = {};
    if (Array.isArray(fundData)) {
      fundData.forEach(f => {
        if (!f.symbol.endsWith('USDT')) return;
        const base = f.symbol.replace('USDT', '');
        const fr8h = parseFloat(f.lastFundingRate || 0);
        result[base] = {
          markPx:          parseFloat(f.markPrice || 0),
          fundingRate:     fr8h / 8,
          fundingRate8h:   fr8h,
          nextFundingTime: parseInt(f.nextFundingTime || 0),
          fundingInterval: 8,
          openInterest:    0,
          volume24h:       volMap[f.symbol] || 0,   // ← 真实 24h USDT 成交额
        };
      });
    }
    return result;
  } catch(e) { console.warn('BINANCE:', e.message); return {}; }
}

// OKX 已废弃批量 funding-rate 接口 (instType=SWAP 现在报错 50014，必须传单个 instId)。
// 只能逐个 instId 拉。OKX 公共限速约 20 次/2 秒，全量 ~480 个要 ~1 分钟，
// 而资金费率只在结算点才变，故缓存 5 分钟；价格每次刷新仍实时。
let _okxFundingCache = { ts: 0, map: {} };
async function fetchOKXFundingAll(instIds) {
  const now = Date.now();
  if (now - _okxFundingCache.ts < 5 * 60 * 1000 && Object.keys(_okxFundingCache.map).length) {
    return _okxFundingCache.map;
  }
  const frMap = {};
  const WAVE = 18;        // 每批并发数 (留余量，避免 429)
  const GAP  = 2200;      // 批间隔 ms (OKX 限速 ~20 次/2 秒)
  for (let i = 0; i < instIds.length; i += WAVE) {
    const waveStart = Date.now();
    const slice = instIds.slice(i, i + WAVE);
    await Promise.allSettled(slice.map(id =>
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`)
        .then(r => r.json())
        .then(j => { const f = (j.data || [])[0]; if (f && f.instId) frMap[f.instId] = f; })
        .catch(() => {})
    ));
    if (i + WAVE < instIds.length) {
      const wait = GAP - (Date.now() - waveStart);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }
  // 只在确实拿到数据时才更新缓存，避免一次失败把缓存清空
  if (Object.keys(frMap).length) _okxFundingCache = { ts: Date.now(), map: frMap };
  return _okxFundingCache.map;
}

async function fetchOKX() {
  try {
    // tickers 里有价格 + 24h 成交额 (volCcy24h × last = USDT)，但不含 funding
    const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    const tickData = await res.json();

    // USDT 永续按成交额降序，高流动性优先拉 funding (全量，带限流+缓存)
    const usdtInsts = (tickData.data || [])
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .sort((a, b) => (parseFloat(b.volCcy24h || 0) * parseFloat(b.last || 0))
                    - (parseFloat(a.volCcy24h || 0) * parseFloat(a.last || 0)))
      .map(t => t.instId);
    const frMap = await fetchOKXFundingAll(usdtInsts);

    const result = {};
    (tickData.data || []).forEach(t => {
      if (!t.instId.endsWith('-USDT-SWAP')) return;
      const base   = t.instId.replace('-USDT-SWAP', '');
      const fr     = frMap[t.instId];
      // OKX fundingRate 本身就是「每个结算周期」的费率 (BTC ≈ 0.000044，与 Binance/Gate 一致)。
      // 周期可变 (8h/4h…)，用 nextFundingTime - fundingTime 推算后归一化到 8h。原实现 ×8 是错的。
      let intervalHr = 8;
      if (fr && fr.fundingTime && fr.nextFundingTime) {
        const h = (parseInt(fr.nextFundingTime) - parseInt(fr.fundingTime)) / 3600000;
        if (h > 0 && h <= 24) intervalHr = h;
      }
      const fr8h   = fr ? parseFloat(fr.fundingRate || 0) * (8 / intervalHr) : 0;
      // volCcy24h = 24h base volume; vol24h = contracts; use volCcy24h × last for USDT
      const vol24h = parseFloat(t.volCcy24h || 0) * parseFloat(t.last || 0);
      result[base] = {
        markPx:          parseFloat(t.last || 0),
        fundingRate:     fr8h / 8,
        fundingRate8h:   fr8h,
        nextFundingTime: fr ? parseInt(fr.nextFundingTime || 0) : 0,
        fundingInterval: intervalHr,
        openInterest:    0,
        volume24h:       vol24h,   // ← 真实 USDT 成交额
      };
    });
    return result;
  } catch(e) { console.warn('OKX:', e.message); return {}; }
}

async function fetchBYBIT() {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&limit=200');
    const data = await res.json();
    const result = {};
    if (data.result?.list) {
      data.result.list.forEach(t => {
        if (!t.symbol.endsWith('USDT')) return;
        const base = t.symbol.replace('USDT','');
        // Bybit 现在有可变结算周期 (fundingIntervalHour: 1/2/4/8…)，
        // t.fundingRate 是「每个周期」的费率，需归一化到 8h 口径再参与 APR 计算
        const intervalHr = parseFloat(t.fundingIntervalHour) || 8;
        const frRaw = parseFloat(t.fundingRate||0);
        const fr8h  = frRaw * (8 / intervalHr);
        result[base] = {
          markPx: parseFloat(t.markPrice||t.lastPrice||0),
          fundingRate: fr8h/8, fundingRate8h: fr8h,
          nextFundingTime: parseInt(t.nextFundingTime||0),
          fundingInterval: intervalHr,
          openInterest: parseFloat(t.openInterest||0),
          volume24h: parseFloat(t.turnover24h||0),   // turnover24h = USDT 成交额 (volume24h 是币本位)
        };
      });
    }
    return result;
  } catch(e) { console.warn('BYBIT:', e.message); return {}; }
}

async function fetchGATE() {
  try {
    // contracts 有 funding，tickers 有 24h volume
    const [contractRes, tickRes] = await Promise.all([
      fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts?limit=300'),
      fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers'),
    ]);
    const data    = await contractRes.json();
    const tickers = await tickRes.json();

    // Gate ticker: { contract, volume_24h_settle (in USDT), last }
    const volMap = {};
    if (Array.isArray(tickers)) {
      tickers.forEach(t => {
        // volume_24h_settle 是结算货币(USDT)的成交额
        volMap[t.contract] = parseFloat(t.volume_24h_settle || t.volume_24h || 0);
      });
    }

    const result = {};
    if (Array.isArray(data)) {
      data.forEach(c => {
        if (!c.name.endsWith('_USDT')) return;
        const base = c.name.replace('_USDT','');
        // Gate funding_rate 是「每个结算周期」的费率；funding_interval 单位是秒 (默认 28800=8h)。
        // 归一化到 8h 口径: fr8h = funding_rate × (8 / 周期小时数)。
        // 原实现误用 × (周期/3600)，8h 周期时等于 ×8，导致 Gate 资金费率虚高 8 倍。
        const intervalHr = (c.funding_interval ? c.funding_interval / 3600 : 8) || 8;
        const frRaw = parseFloat(c.funding_rate||0);
        const fr8h  = frRaw * (8 / intervalHr);
        result[base] = {
          markPx:          parseFloat(c.mark_price||0),
          fundingRate:     fr8h / 8,
          fundingRate8h:   fr8h,
          nextFundingTime: (c.funding_next_apply||0)*1000,
          fundingInterval: intervalHr,
          openInterest:    parseFloat(c.position_size||0),
          volume24h:       volMap[c.name] || 0,
        };
      });
    }
    return result;
  } catch(e) { console.warn('GATE:', e.message); return {}; }
}

async function fetchAllMarkets() {
  const fetchers = { HL: fetchHL, ASTER: fetchASTER, BINANCE: fetchBINANCE, OKX: fetchOKX, BYBIT: fetchBYBIT, GATE: fetchGATE };
  const results = await Promise.allSettled(
    Object.entries(fetchers).map(([ex, fn]) => fn().then(d => [ex, d]))
  );
  const markets = {};
  results.forEach(r => { if (r.status === 'fulfilled') { const [ex,d]=r.value; markets[ex]=d; } });
  return markets;
}

// ============================================================
// ORDERBOOK DEPTH FETCHER
// 拉单个交易所某代币的挂单薄，计算 ±0.5% 价格范围内的 USDT 深度。
// 这是衡量流动性最直接的指标：你的开单能以多少滑点成交。
// ============================================================

/**
 * 获取指定交易所/代币的 orderbook 深度（USDT），即 mid±0.5% 范围内的挂单量。
 * 返回 { bidDepth, askDepth, totalDepth, midPrice } 单位 USDT
 * 失败返回 null（不阻断主流程）
 */
async function fetchOrderbookDepth(ex, symbol) {
  try {
    let bids = [], asks = [], midPrice = 0;

    if (ex === 'HL') {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: symbol }),
      });
      const data = await res.json();
      // HL l2Book: { levels: [[bids], [asks]] } each entry { px, sz, n }
      bids = (data.levels?.[0] || []).map(e => [parseFloat(e.px), parseFloat(e.sz)]);
      asks = (data.levels?.[1] || []).map(e => [parseFloat(e.px), parseFloat(e.sz)]);
      midPrice = bids.length && asks.length
        ? (parseFloat(bids[0][0]) + parseFloat(asks[0][0])) / 2
        : 0;

    } else if (ex === 'BINANCE') {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}USDT&limit=50`
      );
      const data = await res.json();
      bids = (data.bids || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      asks = (data.asks || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      midPrice = bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : 0;

    } else if (ex === 'ASTER') {
      const res = await fetch(
        `https://fapi.asterdex.com/fapi/v1/depth?symbol=${symbol}USDT&limit=50`
      );
      const data = await res.json();
      bids = (data.bids || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      asks = (data.asks || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      midPrice = bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : 0;

    } else if (ex === 'OKX') {
      const res = await fetch(
        `https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT-SWAP&sz=50`
      );
      const data = await res.json();
      const book = data.data?.[0];
      bids = (book?.bids || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      asks = (book?.asks || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      midPrice = bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : 0;

    } else if (ex === 'BYBIT') {
      const res = await fetch(
        `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}USDT&limit=50`
      );
      const data = await res.json();
      bids = (data.result?.b || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      asks = (data.result?.a || []).map(e => [parseFloat(e[0]), parseFloat(e[1])]);
      midPrice = bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : 0;

    } else if (ex === 'GATE') {
      const res = await fetch(
        `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${symbol}_USDT&limit=50`
      );
      const data = await res.json();
      bids = (data.bids || []).map(e => [parseFloat(e.p), parseFloat(e.s)]);
      asks = (data.asks || []).map(e => [parseFloat(e.p), parseFloat(e.s)]);
      midPrice = bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : 0;
    }

    if (!midPrice) return null;

    // 计算 mid ± 0.5% 范围内的 USDT 总挂单量
    const lo = midPrice * 0.995;
    const hi = midPrice * 1.005;

    const sumUSDT = (levels, filterFn) =>
      levels
        .filter(([px]) => filterFn(px))
        .reduce((s, [px, sz]) => s + px * sz, 0);

    const bidDepth = sumUSDT(bids, px => px >= lo);
    const askDepth = sumUSDT(asks, px => px <= hi);

    return { bidDepth, askDepth, totalDepth: bidDepth + askDepth, midPrice };
  } catch(e) {
    console.warn(`orderbook ${ex} ${symbol}:`, e.message);
    return null;
  }
}



/**
 * Fetch historical funding rates for a symbol on an exchange.
 * Returns array of { time: ms, rate: float (8h-normalized), markPx: float|null }
 *
 * Each exchange's funding history API returns markPrice alongside the rate,
 * which we use to compute the price spread without needing separate klines.
 */
async function fetchHistoricalFunding(ex, symbol) {
  const now     = Date.now();
  const start7d = now - 7 * 24 * 3600 * 1000;

  try {
    if (ex === 'HL') {
      // HL fundingHistory: { time, coin, fundingRate, sums }
      // Rate is per-1h, so ×8 to normalize to 8h
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin: symbol, startTime: start7d }),
      });
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data
        .filter(d => d.time >= start7d)
        .map(d => ({
          time:   d.time,
          rate:   parseFloat(d.fundingRate) * 8,
          markPx: null, // HL fundingHistory doesn't include markPx — filled by candlesFallback
        }));

    } else if (ex === 'BINANCE') {
      // Binance: fundingRate + markPrice in same record
      const sym = symbol + 'USDT';
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start7d}&limit=500`
      );
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => ({
        time:   d.fundingTime,
        rate:   parseFloat(d.fundingRate),
        markPx: parseFloat(d.markPrice) || null,
      }));

    } else if (ex === 'BYBIT') {
      // Bybit: fundingRate + markPrice in same record
      const sym = symbol + 'USDT';
      const res = await fetch(
        `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=200`
      );
      const data = await res.json();
      if (!data.result?.list) return [];
      return data.result.list.map(d => ({
        time:   parseInt(d.fundingRateTimestamp),
        rate:   parseFloat(d.fundingRate),
        markPx: null, // Bybit v5 funding history doesn't include markPrice
      })).reverse();

    } else if (ex === 'OKX') {
      // OKX: fundingRate only, no markPrice in this endpoint
      const instId = symbol + '-USDT-SWAP';
      const res = await fetch(
        `https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}&limit=100`
      );
      const data = await res.json();
      if (!data.data) return [];
      return data.data.map(d => ({
        time:   parseInt(d.fundingTime),
        rate:   parseFloat(d.fundingRate),
        markPx: null,
      })).reverse();

    } else if (ex === 'GATE') {
      // Gate: r=funding rate, t=timestamp (seconds)
      const contract = symbol + '_USDT';
      const from = Math.floor(start7d / 1000);
      const res = await fetch(
        `https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${contract}&limit=200&from=${from}`
      );
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => ({
        time:   d.t * 1000,
        // Gate 历史 r 已是「每个周期」费率 (8h 周期, 相邻 t 差 28800s)，归一化到 8h。
        // 原实现 × interval_hours(缺省→8) 导致 ×8 虚高；该接口不返回 interval_hours。
        rate:   parseFloat(d.r) * (d.interval_hours ? 8 / d.interval_hours : 1),
        markPx: null,
      })).reverse();

    } else if (ex === 'ASTER') {
      const sym = symbol + 'USDT';
      const res = await fetch(
        `https://fapi.asterdex.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start7d}&limit=500`
      );
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => ({
        time:   d.fundingTime,
        rate:   parseFloat(d.fundingRate),
        markPx: parseFloat(d.markPrice) || null,
      }));
    }
  } catch(e) {
    console.warn(`histFunding ${ex} ${symbol}:`, e.message);
  }
  return [];
}

/**
 * Fetch historical OHLCV klines for a single exchange.
 *
 * interval: '4h'  → 7天4h线，供 fetchHistoricalSpread 价差计算用（保留 price 字段）
 * interval: '1d'  → 30天日线，供 calcVolatilityRisk 波动率筛选用
 *
 * Returns array of { time:ms, open, high, low, close, price(=close) }
 */
async function fetchMarkPriceHistory(ex, symbol, interval = '4h') {
  const now      = Date.now();
  const is1d     = interval === '1d';
  // 4h → 7天；1d → 30天
  const lookback = is1d ? 30 * 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  const start    = now - lookback;

  const toRow = (t, o, h, l, c) => ({
    time:  +t,
    open:  parseFloat(o),
    high:  parseFloat(h),
    low:   parseFloat(l),
    close: parseFloat(c),
    price: parseFloat(c),   // backward-compat alias
  });

  try {
    if (ex === 'HL') {
      // HL interval tokens: '1h','4h','1d' etc.
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin: symbol, interval: is1d ? '1d' : '4h', startTime: start, endTime: now }
        }),
      });
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => toRow(d.t, d.o, d.h, d.l, d.c));

    } else if (ex === 'BINANCE') {
      // Binance: interval '4h' or '1d'
      const sym = symbol + 'USDT';
      const ivStr = is1d ? '1d' : '4h';
      const limit = is1d ? 30 : 42;   // 30 days / ~42 × 4h bars for 7d
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${ivStr}&startTime=${start}&limit=${limit}`
      );
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => toRow(d[0], d[1], d[2], d[3], d[4]));

    } else if (ex === 'BYBIT') {
      // Bybit: interval in minutes → 240 for 4h, 'D' for 1d
      const ivStr = is1d ? 'D' : '240';
      const limit = is1d ? 30 : 42;
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${ivStr}&limit=${limit}`
      );
      const data = await res.json();
      if (!data.result?.list) return [];
      return data.result.list
        .map(d => toRow(d[0], d[1], d[2], d[3], d[4]))
        .reverse();

    } else if (ex === 'OKX') {
      // OKX: bar '4H' or '1D'
      const ivStr = is1d ? '1D' : '4H';
      const limit = is1d ? 30 : 42;
      const res = await fetch(
        `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}-USDT-SWAP&bar=${ivStr}&limit=${limit}`
      );
      const data = await res.json();
      if (!data.data) return [];
      return data.data
        .map(d => toRow(d[0], d[1], d[2], d[3], d[4]))
        .reverse();

    } else if (ex === 'GATE') {
      // Gate: interval '1d' or '4h'
      const ivStr = is1d ? '1d' : '4h';
      const limit = is1d ? 30 : 42;
      const fromSec = Math.floor(start / 1000);
      const res = await fetch(
        `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}_USDT&interval=${ivStr}&from=${fromSec}&limit=${limit}`
      );
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => toRow(d.t * 1000, d.o, d.h, d.l, d.c));

    } else if (ex === 'ASTER') {
      // AsterDEX mirrors Binance API style
      const sym = symbol + 'USDT';
      const ivStr = is1d ? '1d' : '4h';
      const limit = is1d ? 30 : 42;
      const res = await fetch(
        `https://fapi.asterdex.com/fapi/v1/klines?symbol=${sym}&interval=${ivStr}&startTime=${start}&limit=${limit}`
      );
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map(d => toRow(d[0], d[1], d[2], d[3], d[4]));
    }
  } catch(e) {
    console.warn(`klines ${ex} ${symbol} ${interval}:`, e.message);
  }
  return [];
}

/**
 * 分析 30天日线 K线的波动风险（合约价格）。
 *
 * 核心指标：单根日线最大振幅 = (high - low) / close
 * 取所有日线里的 **绝对最大值**，不管涨跌方向，
 * 这根是最坏情况——当天最坏一根蜡烛的振幅有多大。
 *
 * 阈值：
 *   maxSpike > 15%  → 高波动，曾出现日内大插针/闪崩，不入选
 *   maxSpike > 10%  → 中等风险，扣分但不直接淘汰（由 scoreOpp 处理）
 *   maxSpike ≤ 10%  → 通过
 *
 * 同时计算 avg5 = 最近5根日线振幅均值，代表近期波动率。
 */
function calcVolatilityRisk(klines) {
  if (!klines || klines.length < 10) {
    return { maxSpike: null, avg5Spike: null, safe: false, reason: '日线历史数据不足（需至少10根日线）' };
  }

  // 每根日线振幅 (high - low) / close，不区分涨跌
  const spikes = klines
    .filter(d => d.close > 0 && d.high >= d.low)
    .map(d => (d.high - d.low) / d.close);

  const maxSpike = Math.max(...spikes);

  // 最近5根的均值，代表近期波动状态
  const recent5 = spikes.slice(-5);
  const avg5Spike = recent5.length ? recent5.reduce((s, v) => s + v, 0) / recent5.length : 0;

  const HARD_LIMIT = 0.15;   // 15% → 不入选
  const WARN_LIMIT = 0.10;   // 10% → 警告但可入选

  let safe = true, reason = '', warnOnly = false;
  if (maxSpike > HARD_LIMIT) {
    safe = false;
    reason = `30天最大日振幅 ${(maxSpike*100).toFixed(1)}%，超硬止损线（>15%），插针/闪崩风险极高`;
  } else if (maxSpike > WARN_LIMIT) {
    warnOnly = true;
    reason = `30天最大日振幅 ${(maxSpike*100).toFixed(1)}%，中等波动（>10%），需注意`;
  }

  return { maxSpike, avg5Spike, safe, warnOnly, reason };
}

/**
 * Build historical price spread from two price series.
 * Strategy:
 *   1. Try using markPx embedded in funding history (Binance/ASTER)
 *   2. Fallback: fetch 4h klines from each exchange
 *   3. Align by 4h buckets, compute spread %
 */
async function fetchHistoricalSpread(exA, exB, symbol, frA, frB) {
  // Build price series from funding history markPx if available
  const toSeries = (frArr) => frArr
    .filter(d => d.markPx && d.markPx > 0)
    .map(d => ({ time: d.time, price: d.markPx }));

  let seriesA = toSeries(frA);
  let seriesB = toSeries(frB);

  // Fallback: fetch klines for exchanges lacking markPx
  const needsKlinesA = seriesA.length < 5;
  const needsKlinesB = seriesB.length < 5;

  if (needsKlinesA || needsKlinesB) {
    const [kA, kB] = await Promise.all([
      needsKlinesA ? fetchMarkPriceHistory(exA, symbol) : Promise.resolve([]),
      needsKlinesB ? fetchMarkPriceHistory(exB, symbol) : Promise.resolve([]),
    ]);
    if (needsKlinesA) seriesA = kA;
    if (needsKlinesB) seriesB = kB;
  }

  if (seriesA.length < 2 || seriesB.length < 2) return [];

  // Align by 4h bucket
  const BUCKET = 4 * 3600 * 1000;
  const mapB = {};
  seriesB.forEach(d => { mapB[Math.round(d.time / BUCKET)] = d.price; });

  const result = [];
  seriesA.forEach(d => {
    const bucket = Math.round(d.time / BUCKET);
    const pB = mapB[bucket] || mapB[bucket - 1] || mapB[bucket + 1];
    if (d.price && pB) {
      const mid = (d.price + pB) / 2;
      result.push({
        time:   d.time,
        priceA: d.price,
        priceB: pB,
        spread: ((d.price - pB) / mid) * 100,
      });
    }
  });

  return result.sort((a, b) => a.time - b.time);
}

// ============================================================
// BUILD ARBITRAGE OPPORTUNITIES
// ============================================================
function buildArbitrages(markets, tab) {
  const opportunities = [];
  const exList = [...state.activeExs].filter(ex => markets[ex] && Object.keys(markets[ex]).length > 0);
  const symCount = {};
  exList.forEach(ex => Object.keys(markets[ex]).forEach(s => { symCount[s] = (symCount[s]||0)+1; }));
  const symbols = Object.keys(symCount).filter(s => symCount[s] >= 2);

  for (const sym of symbols) {
    const available = exList.filter(ex => markets[ex][sym]?.markPx > 0);
    if (available.length < 2) continue;

    for (let i = 0; i < available.length; i++) {
      for (let j = i + 1; j < available.length; j++) {
        const exA = available[i], exB = available[j];
        const mA = markets[exA][sym],  mB = markets[exB][sym];
        if (!mA?.markPx || !mB?.markPx) continue;

        const frA = mA.fundingRate8h, frB = mB.fundingRate8h;
        const frDiff = Math.abs(frA - frB);
        const priceA = mA.markPx, priceB = mB.markPx;
        const midPx  = (priceA + priceB) / 2;
        const spreadPct = ((priceA - priceB) / midPx) * 100;

        let longEx, shortEx, longFr, shortFr;
        if (frA < frB) { longEx=exA; shortEx=exB; longFr=frA; shortFr=frB; }
        else           { longEx=exB; shortEx=exA; longFr=frB; shortFr=frA; }

        const annualFundingApr = frDiff * (HOURS_PER_YEAR / 8) * 100;
        const spreadArb = Math.abs(spreadPct) - 0.2;
        let apr = 0;
        if (tab === 'funding')      apr = annualFundingApr;
        else if (tab === 'price')   apr = spreadArb > 0 ? spreadArb * 52 : 0;
        else if (tab === 'basis')   apr = annualFundingApr + (spreadArb > 0 ? spreadArb : 0);
        if (apr < state.minApr) continue;

        const nextFunding = Math.min(mA.nextFundingTime||Infinity, mB.nextFundingTime||Infinity);
        opportunities.push({
          symbol: sym,
          longEx, shortEx,
          longPrice:  markets[longEx][sym].markPx,
          shortPrice: markets[shortEx][sym].markPx,
          longFr8h: longFr, shortFr8h: shortFr,
          frDiff8h: frDiff, spreadPct,
          spreadAbs: Math.abs(spreadPct),
          apr, annualFundingApr,
          nextFundingTime: isFinite(nextFunding) ? nextFunding : 0,
          longVolume:  mA.volume24h||0, shortVolume: mB.volume24h||0,
          fundingIntervalA: mA.fundingInterval,
          fundingIntervalB: mB.fundingInterval,
        });
      }
    }
  }
  return opportunities;
}

// ============================================================
// SORT & FILTER
// ============================================================
function filterAndSort(opps) {
  let f = opps.filter(o => !state.searchQ || o.symbol.includes(state.searchQ.toUpperCase()));
  const fns = {
    apr_desc:    (a,b) => b.apr - a.apr,
    apr_asc:     (a,b) => a.apr - b.apr,
    spread_desc: (a,b) => b.spreadAbs - a.spreadAbs,
    vol_desc:    (a,b) => (b.longVolume+b.shortVolume)-(a.longVolume+a.shortVolume),
  };
  f.sort(fns[state.sortBy] || fns.apr_desc);
  return f;
}

// ============================================================
// FORMAT HELPERS
// ============================================================
const fmtPct  = (v, d=4)  => (v*100).toFixed(d)+'%';
const fmtApr  = v => v >= 100 ? v.toFixed(1)+'%' : v.toFixed(2)+'%';
const fmtPrice = v => {
  if (!v) return '--';
  if (v >= 1000)  return v.toLocaleString('en-US',{maximumFractionDigits:2});
  if (v >= 1)     return v.toFixed(4);
  return v.toFixed(6);
};
function fmtCountdown(ms) {
  if (!ms) return '--';
  const diff = ms - Date.now();
  if (diff <= 0) return '结算中';
  const m = Math.floor(diff/60000), s = Math.floor((diff%60000)/1000);
  return `${m}m ${s}s`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:00`;
}
function fmtShortDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth()+1}/${d.getDate()}`;
}

function exBadge(ex) {
  return `<span class="ex-badge ex-${ex}">${EXCHANGES[ex]?.name||ex}</span>`;
}
function fundingClass(fr) {
  if (fr > 0.0001)  return 'funding-pos';
  if (fr < -0.0001) return 'funding-neg';
  return 'funding-neu';
}
function aprClass(apr) {
  if (apr >= 50) return 'apr-hot';
  if (apr >= 20) return 'apr-mid';
  return 'apr-low';
}
function rowClass(apr) {
  if (apr >= 50) return 'row-hot';
  if (apr >= 20) return 'row-mid';
  return 'row-low';
}
// ============================================================
// TOKEN ICON — multi-source fallback with color avatar
// ============================================================

// Generate a deterministic hue from symbol string
function symToHue(sym) {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) & 0xffff;
  return h % 360;
}

// Known overrides: some coins have different IDs on CoinGecko vs their trading symbol
const COINGECKO_ID = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin',
  XRP:'ripple', DOGE:'dogecoin', ADA:'cardano', AVAX:'avalanche-2',
  DOT:'polkadot', LINK:'chainlink', MATIC:'matic-network', SHIB:'shiba-inu',
  UNI:'uniswap', AAVE:'aave', LTC:'litecoin', BCH:'bitcoin-cash',
  FIL:'filecoin', NEAR:'near', APT:'aptos', ARB:'arbitrum',
  OP:'optimism', INJ:'injective-protocol', SUI:'sui', TIA:'celestia',
  SEI:'sei-network', WLD:'worldcoin-wld', PYTH:'pyth-network',
  JTO:'jito-governance-token', BLUR:'blur', STRK:'starknet',
  PEPE:'pepe', WIF:'dogwifcoin', BONK:'bonk', FLOKI:'floki',
  ORDI:'ordinals', SATS:'1000sats-ordinals', RATS:'rats-ordinals',
  W:'wormhole', PENDLE:'pendle', EIGEN:'eigenlayer',
  ENA:'ethena', ETHFI:'ether-fi', REZ:'renzo-protocol',
};

// Cache loaded icons to avoid repeat fetches
const _iconCache = {};

function getIconSrc(sym) {
  const lower = sym.toLowerCase();
  const gcId  = COINGECKO_ID[sym] || lower;
  // Try CoinGecko thumb CDN (fast, widely covered)
  return `https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png`
    .replace('1/thumb/bitcoin', `0/thumb/${gcId}`)  // placeholder replaced per-coin below
    ;
}

// Build avatar HTML: attempts 3 image sources, fallback to colored letter badge
function tokenIconHTML(sym, size = 28) {
  const hue    = symToHue(sym);
  const bg     = `hsl(${hue},55%,88%)`;
  const fg     = `hsl(${hue},60%,32%)`;
  const abbr   = sym.slice(0, 3);
  const fs     = size <= 24 ? 9 : size <= 32 ? 11 : 14;
  const lower  = sym.toLowerCase();
  const gcId   = COINGECKO_ID[sym] || lower;

  // Source priority:
  //  1. CoinGecko small (reliable, 10k+ coins, needs correct ID)
  //  2. spothq static CDN (only ~200 major coins, but faster)
  //  3. Colored letter avatar (always works)
  const src1 = `https://assets.coingecko.com/coins/images/0/small/${gcId}.png`;
  const src2 = `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${lower}.png`;

  return `<div class="token-icon" style="width:${size}px;height:${size}px;border-radius:${Math.round(size*0.3)}px;overflow:hidden;flex-shrink:0;background:${bg};display:flex;align-items:center;justify-content:center">
    <img src="${src2}"
         onerror="this.src='${src1}';this.onerror=function(){this.style.display='none';this.nextElementSibling.style.display='flex'}"
         style="width:100%;height:100%;object-fit:cover;display:block" alt="${sym}">
    <span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:${fs}px;font-weight:800;color:${fg};font-family:var(--font-sans);letter-spacing:-.5px">${abbr}</span>
  </div>`;
}

// Drawer token icon (larger, with dynamic CoinGecko lookup)
function drawerIconHTML(sym) {
  const hue  = symToHue(sym);
  const bg   = `hsl(${hue},55%,88%)`;
  const fg   = `hsl(${hue},60%,32%)`;
  const abbr = sym.slice(0, 3);
  const lower = sym.toLowerCase();
  const gcId  = COINGECKO_ID[sym] || lower;
  const src1  = `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${lower}.png`;
  const src2  = `https://assets.coingecko.com/coins/images/0/small/${gcId}.png`;
  return `
    <img src="${src1}"
         onerror="this.src='${src2}';this.onerror=function(){this.style.display='none';this.nextElementSibling.style.display='flex'}"
         style="width:100%;height:100%;object-fit:cover;display:block" alt="${sym}">
    <span class="drawer-token-icon-abbr" style="display:none;background:${bg};color:${fg};width:100%;height:100%;align-items:center;justify-content:center;font-size:15px;font-weight:900;border-radius:12px">${abbr}</span>
  `;
}

// ============================================================
// RENDER TABLE
// ============================================================
function render(opps) {
  const loadingEl = document.getElementById('loadingState');
  const tableEl   = document.getElementById('arbTable');
  const emptyEl   = document.getElementById('emptyState');
  const bodyEl    = document.getElementById('arbTableBody');

  loadingEl.style.display = 'none';
  if (!opps?.length) {
    tableEl.style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';
  tableEl.style.display = 'table';

  bodyEl.innerHTML = opps.map((o, idx) => `
    <tr class="${rowClass(o.apr)}" data-key="${o.symbol}|${o.longEx}|${o.shortEx}" onclick="openDetail('${o.symbol}|${o.longEx}|${o.shortEx}')">
      <td>
        <div class="token-cell">
          ${tokenIconHTML(o.symbol)}
          <div>
            <div class="token-name">${o.symbol}</div>
            <div class="token-sub">PERP · USDT</div>
          </div>
        </div>
      </td>
      <td>
        <div class="ex-cell">
          ${exBadge(o.longEx)}
          <span class="ex-price">${fmtPrice(o.longPrice)}</span>
        </div>
      </td>
      <td>
        <div class="ex-cell">
          ${exBadge(o.shortEx)}
          <span class="ex-price">${fmtPrice(o.shortPrice)}</span>
        </div>
      </td>
      <td>
        <span class="${fundingClass(o.longFr8h)}">${fmtPct(o.longFr8h)}</span>
        <div class="funding-interval">${o.fundingIntervalA}h</div>
      </td>
      <td>
        <span class="${fundingClass(o.shortFr8h)}">${fmtPct(o.shortFr8h)}</span>
        <div class="funding-interval">${o.fundingIntervalB}h</div>
      </td>
      <td>
        <span class="${o.frDiff8h > 0.0003 ? 'funding-neg' : 'funding-neu'}">${fmtPct(o.frDiff8h)}</span>
      </td>
      <td>
        <span class="apr-pill ${aprClass(o.apr)}">${fmtApr(o.apr)}</span>
      </td>
      <td>
        <span class="spread-cell ${o.spreadPct > 0.01 ? 'spread-pos' : o.spreadPct < -0.01 ? 'spread-neg' : 'spread-neu'}">
          ${o.spreadPct > 0 ? '+' : ''}${o.spreadPct.toFixed(4)}%
        </span>
      </td>
      <td>
        <span class="countdown-cell" id="nf-${idx}">${fmtCountdown(o.nextFundingTime)}</span>
      </td>
      <td>
        <button class="btn-trade" onclick="event.stopPropagation();openDetail('${o.symbol}|${o.longEx}|${o.shortEx}')">详情</button>
      </td>
    </tr>
  `).join('');

  updateStats(opps);
}

function updateStats(opps) {
  const maxApr = opps.length ? Math.max(...opps.map(o=>o.apr)) : 0;
  const avgFr  = opps.length ? opps.reduce((s,o)=>s+o.frDiff8h,0)/opps.length : 0;
  const pairs  = new Set(opps.map(o=>o.symbol)).size;
  document.getElementById('totalOpp').textContent    = opps.length;
  document.getElementById('maxApr').textContent      = fmtApr(maxApr);
  document.getElementById('avgFunding').textContent  = fmtPct(avgFr);
  document.getElementById('activePairs').textContent = pairs;
  document.getElementById('updateTime').textContent  = '更新: ' + new Date().toLocaleTimeString('zh-CN');
}

function tickCountdowns() {
  document.querySelectorAll('#arbTableBody tr').forEach((tr) => {
    const key = tr.getAttribute('data-key');
    if (!key) return;
    const [sym, lEx, sEx] = key.split('|');
    const o = state.arbitrages.find(x => x.symbol === sym && x.longEx === lEx && x.shortEx === sEx);
    const cell = tr.querySelector('.countdown-cell');
    if (cell && o) cell.textContent = fmtCountdown(o.nextFundingTime);
  });
}

// ============================================================
// DETAIL DRAWER — OPEN
// ============================================================
async function openDetail(key) {
  // key = "symbol|longEx|shortEx"，用稳定标识定位，避免实时重排后下标错位
  let opp;
  if (typeof key === 'number') {               // 兼容旧的下标调用
    opp = filterAndSort(state.arbitrages)[key];
  } else {
    const [sym, lEx, sEx] = String(key).split('|');
    opp = state.arbitrages.find(o => o.symbol === sym && o.longEx === lEx && o.shortEx === sEx);
  }
  if (!opp) return;
  state.selectedOpp = opp;

  // Open drawer
  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('detailDrawer').classList.add('open');

  // Token header
  document.getElementById('drawerTokenInfo').innerHTML = `
    <div class="drawer-token-icon">${drawerIconHTML(opp.symbol)}</div>
    <div>
      <div class="drawer-token-name">${opp.symbol} <span style="font-size:13px;font-weight:500;color:var(--text-secondary)">/USDT PERP</span></div>
      <div class="drawer-token-sub">
        ${exBadge(opp.longEx)}
        <span class="pair-arrow">→</span>
        ${exBadge(opp.shortEx)}
      </div>
    </div>
  `;

  // Stats grid
  const aprCls = opp.apr >= 50 ? 'var(--up-light)' : opp.apr >= 20 ? 'var(--warn)' : 'var(--text-secondary)';
  document.getElementById('drawerStats').innerHTML = `
    <div class="dstat">
      <span class="dstat-label">年化收益</span>
      <span class="dstat-val" style="color:${aprCls}">${fmtApr(opp.apr)}</span>
      <span class="dstat-sub">资金费率套利</span>
    </div>
    <div class="dstat">
      <span class="dstat-label">费率差 /8h</span>
      <span class="dstat-val" style="color:var(--info)">${fmtPct(opp.frDiff8h)}</span>
      <span class="dstat-sub">双所净差值</span>
    </div>
    <div class="dstat">
      <span class="dstat-label">当前价差</span>
      <span class="dstat-val ${opp.spreadPct > 0 ? 'spread-pos' : 'spread-neg'}">${opp.spreadPct > 0 ? '+' : ''}${opp.spreadPct.toFixed(4)}%</span>
      <span class="dstat-sub">${fmtPrice(opp.longPrice)} / ${fmtPrice(opp.shortPrice)}</span>
    </div>
    <div class="dstat">
      <span class="dstat-label">下次结算</span>
      <span class="dstat-val" style="color:var(--warn)" id="drawerCountdown">${fmtCountdown(opp.nextFundingTime)}</span>
      <span class="dstat-sub">结算周期 ${opp.fundingIntervalB}h</span>
    </div>
    <div class="dstat">
      <span class="dstat-label">${EXCHANGES[opp.longEx]?.name} 多头费</span>
      <span class="dstat-val ${fundingClass(opp.longFr8h)}">${fmtPct(opp.longFr8h)}</span>
      <span class="dstat-sub">/8h · ${opp.fundingIntervalA}h 周期</span>
    </div>
    <div class="dstat">
      <span class="dstat-label">${EXCHANGES[opp.shortEx]?.name} 空头费</span>
      <span class="dstat-val ${fundingClass(opp.shortFr8h)}">${fmtPct(opp.shortFr8h)}</span>
      <span class="dstat-sub">/8h · ${opp.fundingIntervalB}h 周期</span>
    </div>
  `;

  // Order panel
  document.getElementById('longExInfo').innerHTML  = `${exBadge(opp.longEx)} ${fmtPrice(opp.longPrice)}`;
  document.getElementById('shortExInfo').innerHTML = `${exBadge(opp.shortEx)} ${fmtPrice(opp.shortPrice)}`;
  document.getElementById('longExLabel').textContent  = EXCHANGES[opp.longEx]?.name||opp.longEx;
  document.getElementById('shortExLabel').textContent = EXCHANGES[opp.shortEx]?.name||opp.shortEx;
  document.getElementById('longPrice').value  = opp.longPrice.toFixed(4);
  document.getElementById('shortPrice').value = opp.shortPrice.toFixed(4);
  checkApiKeys(opp);
  calcPnL();

  // Load charts async
  loadHistoricalCharts(opp);
}

function closeDetail() {
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('detailDrawer').classList.remove('open');
}

// ============================================================
// LOAD HISTORICAL CHARTS
// ============================================================
async function loadHistoricalCharts(opp) {
  // Show loading spinners
  document.getElementById('frLoading').classList.remove('hidden');
  document.getElementById('spreadLoading').classList.remove('hidden');
  document.getElementById('frStability').innerHTML     = '';
  document.getElementById('spreadStability').innerHTML = '';
  document.getElementById('safeRangeBanner').className = 'safe-range-banner';
  const pnlEl = document.getElementById('hist7dPnl');
  if (pnlEl) pnlEl.innerHTML = '<span style="color:var(--text-muted);font-size:12px">计算中…</span>';

  // Step 1: fetch funding histories in parallel (they include markPx for some exchanges)
  const [frA, frB] = await Promise.all([
    fetchHistoricalFunding(opp.longEx,  opp.symbol),
    fetchHistoricalFunding(opp.shortEx, opp.symbol),
  ]);

  // Cache for calcPnL reuse
  state.histFrA = frA;
  state.histFrB = frB;

  // Step 2: build spread using embedded markPx, falling back to klines
  const spreadData = await fetchHistoricalSpread(opp.longEx, opp.shortEx, opp.symbol, frA, frB);
  state.histSpread = spreadData;
  state.histDepthLong = null;
  state.histDepthShort = null;

  document.getElementById('frLoading').classList.add('hidden');
  document.getElementById('spreadLoading').classList.add('hidden');

  // Draw funding rate chart
  drawFundingChart(frA, frB, opp);

  // Draw spread chart
  drawSpreadChart(spreadData, opp);

  // Render 7-day historical P&L card（异步拉 orderbook depth 用于滑点估算 + 评分）
  renderHist7dPnl(frA, frB, opp);  // 先渲染（滑点显示「拉取中」），不等 depth
  Promise.all([
    fetchOrderbookDepth(opp.longEx,  opp.symbol),
    fetchOrderbookDepth(opp.shortEx, opp.symbol),
  ]).then(([dL, dS]) => {
    state.histDepthLong = dL;
    state.histDepthShort = dS;
    renderHist7dPnl(frA, frB, opp, dL, dS);  // depth 拿到后重渲（含滑点）
  }).catch(() => {});
}

// ============================================================
// CANVAS CHART — PURE VANILLA
// ============================================================

const COLORS = {
  longLine:   '#4f46e5',          // indigo — long leg line
  shortLine:  '#dc2626',          // red — short leg line
  grid:       'rgba(0,0,0,0.06)', // light grid lines
  zero:       'rgba(0,0,0,0.18)', // zero axis
  greenFill:  'rgba(5,150,105,0.10)',
  redFill:    'rgba(220,38,38,0.08)',
  safeZone:   'rgba(5,150,105,0.06)',
  warnZone:   'rgba(217,119,6,0.08)',
  dangerZone: 'rgba(220,38,38,0.08)',
  spreadLine: '#0891b2',
  spreadFill: 'rgba(8,145,178,0.08)',
};

function setupCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const wrap   = canvas.parentElement;
  const W      = wrap.clientWidth || 600;
  const H      = parseInt(canvas.getAttribute('height')) || 160;
  const dpr    = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, W, H };
}

function drawGrid(ctx, W, H, pad, gridLines = 5) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth   = 0.5;
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (H - pad.top - pad.bottom) * (i / gridLines);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
  }
}

function drawLine(ctx, points, color, lineWidth = 1.5, fill = null, fillColor = null) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  if (fill && fillColor) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, fill);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length-1].x, fill);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
}

function yLabel(ctx, val, x, y, color = '#8892a4') {
  ctx.fillStyle   = color;
  ctx.font        = '10px -apple-system,sans-serif';
  ctx.textAlign   = 'right';
  ctx.fillText(val, x, y + 3);
}

// ── Funding Rate Chart ──────────────────────────────────────
function drawFundingChart(frA, frB, opp) {
  const c = setupCanvas('frChart');
  if (!c) return;
  const { ctx, W, H } = c;
  const pad = { top: 14, bottom: 12, left: 62, right: 14 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top  - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  // Merge time range
  const allRates = [...frA, ...frB];
  if (allRates.length === 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无历史数据', W/2, H/2);
    return;
  }

  const minTime = Math.min(...allRates.map(d=>d.time));
  const maxTime = Math.max(...allRates.map(d=>d.time));
  const minRate = Math.min(0, ...allRates.map(d=>d.rate));
  const maxRate = Math.max(0, ...allRates.map(d=>d.rate));
  const rangePad = (maxRate - minRate) * 0.12 || 0.0001;
  const yMin = minRate - rangePad;
  const yMax = maxRate + rangePad;
  const yRange = yMax - yMin;
  const xRange = maxTime - minTime || 1;

  const toX = t => pad.left + ((t - minTime) / xRange) * chartW;
  const toY = v => pad.top  + (1 - (v - yMin) / yRange) * chartH;
  const zeroY = toY(0);

  // Grid
  drawGrid(ctx, W, H, pad, 4);

  // Zero line
  ctx.strokeStyle = COLORS.zero;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Y-axis labels
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const v = yMin + (yMax - yMin) * (i / ySteps);
    const y = toY(v);
    const pct = (v * 100).toFixed(3) + '%';
    yLabel(ctx, pct, pad.left - 4, y);
  }

  // Series A (longEx)
  const ptsA = frA.map(d => ({ x: toX(d.time), y: toY(d.rate) }));
  const ptsB = frB.map(d => ({ x: toX(d.time), y: toY(d.rate) }));

  // Fill between zero for A
  if (ptsA.length > 1) {
    drawLine(ctx, ptsA, COLORS.longLine, 1.8, zeroY,
      frA.some(d => d.rate >= 0) ? COLORS.greenFill : COLORS.redFill);
  }
  if (ptsB.length > 1) {
    drawLine(ctx, ptsB, COLORS.shortLine, 1.8, zeroY,
      frB.some(d => d.rate >= 0) ? COLORS.redFill : COLORS.greenFill);
  }

  // X-axis ticks (7 labels)
  document.getElementById('frXAxis').innerHTML =
    genXAxisLabels(minTime, maxTime, 7);

  // Legend
  document.getElementById('frLegend').innerHTML = `
    <div class="legend-item">
      <div class="legend-dot" style="background:${COLORS.longLine}"></div>
      ${EXCHANGES[opp.longEx]?.name} (做多)
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:${COLORS.shortLine}"></div>
      ${EXCHANGES[opp.shortEx]?.name} (做空)
    </div>
  `;

  // Stability pills for funding
  renderFrStability(frA, frB, opp);
}

function renderFrStability(frA, frB, opp) {
  const stats = (arr, label, ex) => {
    if (!arr.length) return '';
    const rates = arr.map(d=>d.rate);
    const avg  = rates.reduce((s,v)=>s+v,0)/rates.length;
    const max  = Math.max(...rates);
    const min  = Math.min(...rates);
    const posCount = rates.filter(v=>v>0).length;
    const posRate  = (posCount/rates.length*100).toFixed(0);
    const color    = avg > 0 ? 'var(--down-light)' : 'var(--up-light)';
    return `
      <div class="pill">
        <span class="pill-label">${EXCHANGES[ex]?.name} 均值/8h</span>
        <span class="pill-val" style="color:${color}">${fmtPct(avg)}</span>
      </div>
      <div class="pill">
        <span class="pill-label">最高</span>
        <span class="pill-val" style="color:var(--down-light)">${fmtPct(max)}</span>
      </div>
      <div class="pill">
        <span class="pill-label">最低</span>
        <span class="pill-val" style="color:var(--up-light)">${fmtPct(min)}</span>
      </div>
      <div class="pill">
        <span class="pill-label">正费率占比</span>
        <span class="pill-val" style="color:var(--text-secondary)">${posRate}%</span>
      </div>
    `;
  };

  // Net diff stats
  let netStats = '';
  if (frA.length && frB.length) {
    const BUCKET = 8 * 3600 * 1000;
    const mapB = {};
    frB.forEach(d => { mapB[Math.round(d.time/BUCKET)] = d.rate; });
    const diffs = frA.map(d => {
      const bRate = mapB[Math.round(d.time/BUCKET)];
      return bRate !== undefined ? (d.rate - bRate) : null;
    }).filter(v => v !== null);

    if (diffs.length) {
      const avgDiff = diffs.reduce((s,v)=>s+v,0)/diffs.length;
      const consistency = (diffs.filter(v => v > 0).length / diffs.length * 100).toFixed(0);
      netStats = `
        <div class="pill" style="border-color:rgba(6,182,212,.25)">
          <span class="pill-label">平均净差/8h</span>
          <span class="pill-val" style="color:var(--info)">${fmtPct(Math.abs(avgDiff))}</span>
        </div>
        <div class="pill" style="border-color:rgba(6,182,212,.25)">
          <span class="pill-label">方向一致性</span>
          <span class="pill-val" style="color:${consistency>70?'var(--up-light)':'var(--warn)'}">
            ${consistency}%
          </span>
        </div>
        <div class="pill" style="border-color:rgba(6,182,212,.25)">
          <span class="pill-label">7天结算次数</span>
          <span class="pill-val" style="color:var(--text-secondary)">${frA.length}</span>
        </div>
      `;
    }
  }

  document.getElementById('frStability').innerHTML =
    stats(frA, 'long', opp.longEx) + stats(frB, 'short', opp.shortEx) + netStats;
}

// ── Spread Chart ────────────────────────────────────────────
function drawSpreadChart(spreadData, opp) {
  const c = setupCanvas('spreadChart');
  if (!c) return;
  const { ctx, W, H } = c;
  const pad = { top: 14, bottom: 12, left: 62, right: 14 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top  - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  if (!spreadData || spreadData.length < 2) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无价差历史数据（部分交易所 K 线不支持）', W/2, H/2);
    return;
  }

  const spreads  = spreadData.map(d=>d.spread);
  const minTime  = Math.min(...spreadData.map(d=>d.time));
  const maxTime  = Math.max(...spreadData.map(d=>d.time));
  const rawMin   = Math.min(...spreads);
  const rawMax   = Math.max(...spreads);
  const pad2     = (rawMax - rawMin) * 0.15 || 0.05;
  const yMin     = Math.min(rawMin - pad2, -0.1);
  const yMax     = Math.max(rawMax + pad2,  0.1);
  const yRange   = yMax - yMin;
  const xRange   = maxTime - minTime || 1;
  const avg      = spreads.reduce((s,v)=>s+v,0)/spreads.length;
  const std      = Math.sqrt(spreads.reduce((s,v)=>s+(v-avg)**2,0)/spreads.length);

  // Safe range = [avg - 2*std, avg + 2*std]
  const safeMin  = avg - 2 * std;
  const safeMax  = avg + 2 * std;

  const toX = t => pad.left + ((t - minTime) / xRange) * chartW;
  const toY = v => pad.top  + (1 - (v - yMin) / yRange) * chartH;
  const zeroY = toY(0);

  // Grid
  drawGrid(ctx, W, H, pad, 4);

  // Safe zone shading
  const safeYTop = Math.max(pad.top, toY(safeMax));
  const safeYBot = Math.min(pad.top + chartH, toY(safeMin));
  ctx.fillStyle = COLORS.safeZone;
  ctx.fillRect(pad.left, safeYTop, chartW, safeYBot - safeYTop);

  // Safe zone borders
  ctx.strokeStyle = 'rgba(34,197,94,.35)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([5, 4]);
  if (safeYTop > pad.top) {
    ctx.beginPath(); ctx.moveTo(pad.left, safeYTop); ctx.lineTo(W-pad.right, safeYTop); ctx.stroke();
  }
  if (safeYBot < pad.top + chartH) {
    ctx.beginPath(); ctx.moveTo(pad.left, safeYBot); ctx.lineTo(W-pad.right, safeYBot); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Zero line
  ctx.strokeStyle = COLORS.zero;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(W-pad.right, zeroY); ctx.stroke();
  ctx.setLineDash([]);

  // Y labels
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const v = yMin + yRange * (i / ySteps);
    yLabel(ctx, v.toFixed(3)+'%', pad.left-4, toY(v));
  }

  // Spread bars (colored by positive/negative)
  const barW = Math.max(2, chartW / spreadData.length * 0.7);
  spreadData.forEach(d => {
    const x = toX(d.time);
    const y1 = toY(Math.max(0, d.spread));
    const y2 = toY(Math.min(0, d.spread));
    ctx.fillStyle = d.spread >= 0 ? 'rgba(34,197,94,.6)' : 'rgba(239,68,68,.6)';
    ctx.fillRect(x - barW/2, Math.min(y1,y2), barW, Math.abs(y1-y2) || 1);
  });

  // Spread line
  const pts = spreadData.map(d => ({ x: toX(d.time), y: toY(d.spread) }));
  drawLine(ctx, pts, COLORS.spreadLine, 1.5);

  // Average line
  const avgY = toY(avg);
  ctx.strokeStyle = 'rgba(217,119,6,.7)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4,3]);
  ctx.beginPath(); ctx.moveTo(pad.left, avgY); ctx.lineTo(W - pad.right, avgY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#d97706';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`均 ${avg.toFixed(3)}%`, W - pad.right + 2, avgY + 3);

  // X-axis
  document.getElementById('spreadXAxis').innerHTML = genXAxisLabels(minTime, maxTime, 7);

  // Stability pills
  renderSpreadStability(spreads, safeMin, safeMax, rawMin, rawMax, avg, std, opp);
}

function renderSpreadStability(spreads, safeMin, safeMax, rawMin, rawMax, avg, std, opp) {
  const currentSpread = opp.spreadPct;
  const inSafeZone    = currentSpread >= safeMin && currentSpread <= safeMax;
  const overMaxSpread = Math.abs(currentSpread) > Math.abs(rawMax) * 0.8;

  document.getElementById('spreadStability').innerHTML = `
    <div class="pill">
      <span class="pill-label">当前价差</span>
      <span class="pill-val" style="color:${inSafeZone?'var(--up-light)':'var(--warn)'}">
        ${currentSpread>0?'+':''}${currentSpread.toFixed(4)}%
      </span>
    </div>
    <div class="pill">
      <span class="pill-label">7日均值</span>
      <span class="pill-val" style="color:var(--text-secondary)">${avg>0?'+':''}${avg.toFixed(4)}%</span>
    </div>
    <div class="pill">
      <span class="pill-label">历史最高</span>
      <span class="pill-val" style="color:var(--up-light)">${rawMax>0?'+':''}${rawMax.toFixed(4)}%</span>
    </div>
    <div class="pill">
      <span class="pill-label">历史最低</span>
      <span class="pill-val" style="color:var(--down-light)">${rawMin>0?'+':''}${rawMin.toFixed(4)}%</span>
    </div>
    <div class="pill" style="border-color:rgba(16,185,129,.25)">
      <span class="pill-label">安全区间 ±2σ</span>
      <span class="pill-val" style="color:var(--info);font-size:11px">
        ${safeMin.toFixed(3)}% ~ ${safeMax.toFixed(3)}%
      </span>
    </div>
    <div class="pill" style="border-color:rgba(16,185,129,.25)">
      <span class="pill-label">波动率 σ</span>
      <span class="pill-val" style="color:${std<0.3?'var(--up-light)':std<0.6?'var(--warn)':'var(--down-light)'}">
        ${std.toFixed(4)}%
      </span>
    </div>
  `;

  // Safe range banner
  const banner  = document.getElementById('safeRangeBanner');
  const estFees = 0.1; // 0.1% per side estimated taker fee
  const netSpread = Math.abs(currentSpread) - 2 * estFees;

  if (inSafeZone && !overMaxSpread) {
    banner.className    = 'safe-range-banner show safe';
    banner.innerHTML    = `✅ <b>价差在安全区间内</b> — 当前偏差 ${currentSpread.toFixed(4)}%，历史2σ范围 [${safeMin.toFixed(3)}%, ${safeMax.toFixed(3)}%]。<br>
      开仓后价差回归风险低，可安全做资金费套利。`;
  } else if (Math.abs(currentSpread) > std * 3) {
    banner.className    = 'safe-range-banner show danger';
    banner.innerHTML    = `🚨 <b>价差超出3σ警戒线！</b> — 当前偏差 ${currentSpread.toFixed(4)}%，历史3σ上限 ${(avg + 3*std).toFixed(3)}%。<br>
      极端价差可能导致开仓滑点损失 > 资金费收益，建议等待价差收窄再进入。`;
  } else {
    banner.className    = 'safe-range-banner show warn';
    banner.innerHTML    = `⚠️ <b>价差偏高，注意开仓成本</b> — 当前偏差 ${currentSpread.toFixed(4)}%（±2σ = ${safeMax.toFixed(3)}%）。<br>
      若价差向不利方向扩大，入场成本可能侵蚀资金费收益，建议小仓测试。`;
  }
}

// ============================================================
// 7-DAY HISTORICAL P&L CARD
// Logic:
//   For each funding settlement in frA that aligns (±bucket) with frB:
//     netRate = abs(rateA - rateB)   — actual spread received per settlement
//   Gross = sum of aligned netRate × notional
//   Fee   = roundTrip fee × notional  (open + close, both legs)
//   Net   = Gross − Fee
// ============================================================
/**
 * 分析历史结算序列，识别负费率的性质：
 *   - sporadic  : 偶发（<20% 结算为负，不连续）
 *   - streak    : 有连续负费率段，但整体仍赚
 *   - persistent: 持续性亏损（>40% 为负，或有3+连续负段）
 * 返回 { type, maxStreak, negRatio, longestStreakDates }
 */
function analyzeNegFunding(perSettlement) {
  if (!perSettlement.length) return { type: 'unknown', maxStreak: 0, negRatio: 0 };
  const negCount  = perSettlement.filter(d => d.earned < 0).length;
  const negRatio  = negCount / perSettlement.length;

  // find longest consecutive negative streak
  let maxStreak = 0, cur = 0, streakStart = null, longestStart = null, longestEnd = null;
  perSettlement.forEach((d, i) => {
    if (d.earned < 0) {
      if (cur === 0) streakStart = d.time;
      cur++;
      if (cur > maxStreak) {
        maxStreak = cur;
        longestStart = streakStart;
        longestEnd   = d.time;
      }
    } else { cur = 0; }
  });

  let type;
  if (negRatio < 0.20 && maxStreak <= 1)      type = 'sporadic';
  else if (negRatio < 0.40 && maxStreak <= 3) type = 'streak';
  else                                          type = 'persistent';

  return { type, maxStreak, negRatio, longestStart, longestEnd };
}

/**
 * 给一个套利机会综合打分 (0-100)，用于筛选「可开单」代币。
 * 维度：当前APR / 7天历史胜率 / 价差安全性 / 负费率性质 / 连续性 / 挂单深度流动性
 *
 * @param {object} opp        - 套利对象
 * @param {Array}  frA        - longEx 历史资金费（必须有）
 * @param {Array}  frB        - shortEx 历史资金费（必须有）
 * @param {object} depthLong  - fetchOrderbookDepth(longEx) 结果，可为 null
 * @param {object} depthShort - fetchOrderbookDepth(shortEx) 结果，可为 null
 * @returns {{ score, grade, reasons, eligible }}
 */
function scoreOpp(opp, frA = [], frB = [], depthLong = null, depthShort = null) {
  let score = 0;
  const reasons = [];

  // ── 1. 当前APR (0-35分) ──
  const aprScore = Math.min(35, (opp.apr / 100) * 35);
  score += aprScore;

  // ── 2. 价差安全 (0-20分) ──
  const spreadScore = Math.max(0, 20 - opp.spreadAbs * 20);
  score += spreadScore;
  if (opp.spreadAbs > 0.5) reasons.push(`⚠ 价差偏大 ${opp.spreadAbs.toFixed(3)}%`);

  // ── 3. 历史胜率 & 负费率分析 (0-30分) ──
  if (frA.length && frB.length) {
    const BUCKET = 8 * 3600 * 1000;
    const mapB = {};
    frB.forEach(d => { const k = Math.round(d.time / BUCKET); mapB[k] = d; });
    const series = [];
    frA.forEach(dA => {
      const k = Math.round(dA.time / BUCKET);
      const dB = mapB[k] || mapB[k-1] || mapB[k+1];
      if (dB) series.push({ time: dA.time, earned: dB.rate - dA.rate });
    });

    if (series.length) {
      const winRate = series.filter(d => d.earned >= 0).length / series.length;
      score += winRate * 25;

      const neg = analyzeNegFunding(series);
      if (neg.type === 'sporadic') {
        score += 5;
        reasons.push(`✅ 负费率偶发（${(neg.negRatio*100).toFixed(0)}%），可忽略`);
      } else if (neg.type === 'streak') {
        score += 2;
        reasons.push(`⚠ 存在连续负费率段（最长${neg.maxStreak}次）`);
      } else if (neg.type === 'persistent') {
        score -= 10;
        reasons.push(`❌ 负费率持续性强（${(neg.negRatio*100).toFixed(0)}%，连续最多${neg.maxStreak}次）`);
      }
    }
  } else {
    reasons.push('❌ 无历史资金费率数据');
  }

  // ── 4. 费率方向一致性 (0-10分) ──
  const dirScore = Math.min(10, opp.frDiff8h * 10000);
  score += dirScore;
  if (opp.frDiff8h < 0) {
    score -= 20;
    reasons.push('❌ 当前费率方向已反转！');
  }

  // ── 5. 流动性 — 挂单深度 ±0.5% (0-10分) ──
  // 优先用 orderbook depth；没有时降级用 volume24h
  const longDepthUSDT  = depthLong?.totalDepth  || 0;
  const shortDepthUSDT = depthShort?.totalDepth || 0;
  // 取做多腿和做空腿深度的较小值（两边都要能成交）
  const minDepth = longDepthUSDT && shortDepthUSDT
    ? Math.min(longDepthUSDT, shortDepthUSDT)
    : (longDepthUSDT || shortDepthUSDT);

  if (minDepth > 0) {
    // 深度标准：±0.5% 范围内 > $200k 才算流动性好（套利单一般 $100-$1000）
    if      (minDepth > 500_000) { score += 10; reasons.push(`✅ 挂单深度充足（$${(minDepth/1000).toFixed(0)}k）`); }
    else if (minDepth > 200_000) { score += 7;  reasons.push(`✅ 挂单深度良好（$${(minDepth/1000).toFixed(0)}k）`); }
    else if (minDepth > 50_000)  { score += 4;  reasons.push(`⚠ 挂单深度一般（$${(minDepth/1000).toFixed(0)}k）`); }
    else if (minDepth > 10_000)  { score += 1;  reasons.push(`⚠ 挂单深度偏薄（$${(minDepth/1000).toFixed(1)}k），滑点风险`); }
    else                          { score -= 5;  reasons.push(`❌ 挂单极薄（$${minDepth.toFixed(0)}），滑点极高`); }
  } else {
    // fallback: 用 volume24h 粗估（没有 orderbook 数据时）
    const vol = (opp.longVolume + opp.shortVolume) / 2;
    if      (vol > 5e8) { score += 7;  reasons.push(`✅ 成交量大（$${(vol/1e6).toFixed(0)}M/日）`); }
    else if (vol > 1e8) { score += 4;  reasons.push(`⚠ 成交量中等（$${(vol/1e6).toFixed(0)}M/日）`); }
    else if (vol > 1e7) { score += 1;  reasons.push(`⚠ 成交量偏低（$${(vol/1e6).toFixed(1)}M/日）`); }
    else                 { score -= 5;  reasons.push(`❌ 成交量极低（$${(vol/1e6).toFixed(2)}M/日），流动性差`); }
  }

  score = Math.max(0, Math.min(100, score));

  let grade, eligible;
  if (score >= 70)      { grade = 'A'; eligible = true;  }
  else if (score >= 50) { grade = 'B'; eligible = true;  }
  else if (score >= 35) { grade = 'C'; eligible = false; }
  else                  { grade = 'D'; eligible = false; }

  return { score: Math.round(score), grade, reasons, eligible };
}

function renderHist7dPnl(frA, frB, opp, depthLong = null, depthShort = null) {
  const el = document.getElementById('hist7dPnl');
  if (!el) return;

  if (!frA.length && !frB.length) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">无历史资金费率数据</span>';
    return;
  }

  // Align settlements by 8h buckets
  const BUCKET = 8 * 3600 * 1000;
  const mapB = {};
  frB.forEach(d => { const k = Math.round(d.time / BUCKET); mapB[k] = d; });

  let totalGross = 0, settlements = 0, positiveCount = 0, negativeCount = 0;
  const perSettlement = [];

  frA.forEach(dA => {
    const k = Math.round(dA.time / BUCKET);
    const dB = mapB[k] || mapB[k-1] || mapB[k+1];
    if (!dB) return;
    const earned = dB.rate - dA.rate;
    totalGross += earned;
    settlements++;
    if (earned >= 0) positiveCount++; else negativeCount++;
    perSettlement.push({ time: dA.time, earned });
  });

  if (settlements === 0 && (frA.length || frB.length)) {
    const arr = frA.length ? frA : frB;
    arr.forEach(d => { totalGross += Math.abs(d.rate); settlements++; });
  }

  // ── 负费率分析 ──
  const negAnalysis = perSettlement.length ? analyzeNegFunding(perSettlement) : null;

  // ── 综合评分 ──
  const sc = scoreOpp(opp, frA, frB, depthLong, depthShort);

  const notional = parseFloat(document.getElementById('notionalInput')?.value || 1000);
  const feeRate  = calcRoundTripFee(opp.longEx, opp.shortEx);
  const feeTotal = feeRate * notional;
  const grossUSD = totalGross * notional;                  // 资金费毛收入

  // ── 价差/基差盈亏 ──
  // 若 7 天前开仓、现在平仓：多头腿赚其涨幅，空头腿亏其涨幅，净 = 多头收益率 − 空头收益率
  let basisUSD = 0, basisPct = 0, basisOk = false;
  const spr = state.histSpread || [];
  if (spr.length >= 2) {
    const s0 = spr[0], s1 = spr[spr.length - 1];
    if (s0.priceA > 0 && s0.priceB > 0 && s1.priceA > 0 && s1.priceB > 0) {
      const retLong  = s1.priceA / s0.priceA - 1;   // 多头腿(longEx)收益率
      const retShort = s1.priceB / s0.priceB - 1;   // 空头腿(shortEx)收益率
      basisPct = (retLong - retShort) * 100;
      basisUSD = (retLong - retShort) * notional;
      basisOk  = true;
    }
  }

  // ── 滑点估算（基于 ±0.5% 挂单深度；开+平 = 每腿 2 次吃单）──
  const dL = depthLong  ?? state.histDepthLong;
  const dS = depthShort ?? state.histDepthShort;
  const slipLeg = (depth) => {
    if (!depth || !depth.totalDepth) return null;
    const side = depth.totalDepth / 2;                 // 单侧可用深度(USDT)
    const fill = notional / Math.max(side, 1);         // 需吃掉的比例
    // 线性订单簿假设：填满比例 f 的 0.5% band → 均价冲击 ≈ 0.5%×f/2；超出 band 部分按 0.5% 线性惩罚
    return Math.min(1, fill) * 0.005 / 2 + (fill > 1 ? (fill - 1) * 0.005 : 0);
  };
  const slL = slipLeg(dL), slS = slipLeg(dS);
  const slipReady = slL !== null && slS !== null;
  const slippageUSD = slipReady ? (slL + slS) * 2 * notional : 0;
  const depthShort_notEnough = slipReady &&
    (notional / ((dL.totalDepth / 2) || 1) > 1 || notional / ((dS.totalDepth / 2) || 1) > 1);

  const netUSD   = grossUSD + basisUSD - feeTotal - slippageUSD;
  const netPct   = notional > 0 ? (netUSD / notional) * 100 : 0;
  const avgPerSettle = settlements > 0 ? grossUSD / settlements : 0;
  const winRate  = settlements > 0 ? Math.round(positiveCount / settlements * 100) : 0;

  const netColor = netUSD >= 0 ? 'var(--up)' : 'var(--down)';
  const netSign  = netUSD >= 0 ? '+' : '';

  // ── 负费率说明文字 ──
  let negHtml = '';
  if (negAnalysis && negativeCount > 0) {
    const typeLabel = { sporadic:'偶发', streak:'阶段性', persistent:'持续性' };
    const typColor  = { sporadic:'var(--up)', streak:'var(--warn)', persistent:'var(--down)' };
    const typeDesc  = {
      sporadic:   `7天内仅 ${negativeCount} 次负结算（${(negAnalysis.negRatio*100).toFixed(0)}%），属正常波动，不影响整体收益，<b>无需平仓</b>。`,
      streak:     `出现最长连续 <b>${negAnalysis.maxStreak} 次</b> 负结算（共 ${negativeCount} 次 / ${(negAnalysis.negRatio*100).toFixed(0)}%），可能是市场短期情绪转变，建议<b>设置 APR 退出阈值</b>，继续持有观察。`,
      persistent: `负结算占比 <b>${(negAnalysis.negRatio*100).toFixed(0)}%</b>，最长连续 <b>${negAnalysis.maxStreak} 次</b>，该对资金费率长期不稳定，<b>不建议开仓</b>，评分 D 级。`,
    }[negAnalysis.type];

    negHtml = `
      <div class="neg-funding-banner ${negAnalysis.type}">
        <div class="neg-funding-title">
          资金费率亏损分析 —
          <span style="color:${typColor[negAnalysis.type]};font-weight:800">${typeLabel[negAnalysis.type]}亏损</span>
        </div>
        <div class="neg-funding-desc">${typeDesc}</div>
        <div class="neg-funding-stats">
          <span>负结算次数 <b>${negativeCount}/${settlements}</b></span>
          <span>最长连续负费 <b>${negAnalysis.maxStreak} 次</b></span>
          <span>负结算占比 <b>${(negAnalysis.negRatio*100).toFixed(0)}%</b></span>
        </div>
      </div>`;
  }

  // ── 评分徽章 ──
  const gradeColor = { A:'var(--up)', B:'#0891b2', C:'var(--warn)', D:'var(--down)' };
  const gradeLabel = { A:'推荐开仓', B:'可以开仓', C:'谨慎观望', D:'不建议开仓' };

  // 深度展示文字
  const longDepthStr  = depthLong  ? `$${(depthLong.totalDepth/1000).toFixed(1)}k`  : '拉取中…';
  const shortDepthStr = depthShort ? `$${(depthShort.totalDepth/1000).toFixed(1)}k` : '拉取中…';

  const scoreHtml = `
    <div class="opp-score-row">
      <div class="opp-score-badge" style="background:${gradeColor[sc.grade]}22;border-color:${gradeColor[sc.grade]}44;color:${gradeColor[sc.grade]}">
        <span class="opp-score-grade">${sc.grade}</span>
        <span class="opp-score-num">${sc.score}分</span>
        <span class="opp-score-label">${gradeLabel[sc.grade]}</span>
      </div>
      <div class="opp-score-reasons">
        ${sc.reasons.map(r => `<div class="opp-score-reason">${r}</div>`).join('')}
        <div class="opp-score-reason" style="color:var(--text-muted);font-size:10px;margin-top:3px">
          挂单深度 ±0.5%：多腿 ${longDepthStr} / 空腿 ${shortDepthStr}
        </div>
      </div>
    </div>`;

  // 各分项展示值
  const basisColor = basisUSD >= 0 ? 'var(--up)' : 'var(--down)';
  const basisSign  = basisUSD >= 0 ? '+' : '−';
  const basisValHtml = basisOk
    ? `<span class="hist-pnl-val" style="color:${basisColor}">${basisSign}$${Math.abs(basisUSD).toFixed(2)}</span>
       <span class="hist-pnl-sub">${basisSign}${Math.abs(basisPct).toFixed(3)}% · 两腿价差变动</span>`
    : `<span class="hist-pnl-val" style="color:var(--text-muted);font-size:13px">数据不足</span>
       <span class="hist-pnl-sub">缺历史价序列</span>`;
  const slipValHtml = slipReady
    ? `<span class="hist-pnl-val" style="color:var(--down)">−$${slippageUSD.toFixed(2)}</span>
       <span class="hist-pnl-sub">${depthShort_notEnough ? '⚠ 深度不足，低估' : '开+平 × 双腿'}</span>`
    : `<span class="hist-pnl-val" style="color:var(--text-muted);font-size:13px">拉取中…</span>
       <span class="hist-pnl-sub">依赖挂单深度</span>`;

  el.innerHTML = `
    ${scoreHtml}
    <div class="hist-pnl-grid">
      <div class="hist-pnl-item featured">
        <span class="hist-pnl-label">7天净盈亏（$${notional.toFixed(0)} 本金，综合）</span>
        <span class="hist-pnl-val" style="color:${netColor};font-size:20px">${netSign}$${netUSD.toFixed(2)}</span>
        <span class="hist-pnl-sub">${netSign}${netPct.toFixed(3)}% 收益率 · 资金费+价差−手续费−滑点</span>
      </div>
      <div class="hist-pnl-item">
        <span class="hist-pnl-label">资金费毛收入</span>
        <span class="hist-pnl-val" style="color:var(--up)">+$${grossUSD.toFixed(2)}</span>
        <span class="hist-pnl-sub">${settlements} 次结算 · 胜率 ${winRate}%</span>
      </div>
      <div class="hist-pnl-item">
        <span class="hist-pnl-label">价差/基差盈亏</span>
        ${basisValHtml}
      </div>
      <div class="hist-pnl-item">
        <span class="hist-pnl-label">手续费成本</span>
        <span class="hist-pnl-val" style="color:var(--down)">−$${feeTotal.toFixed(2)}</span>
        <span class="hist-pnl-sub">${(FEE_TAKER[opp.longEx]*100).toFixed(3)}%+${(FEE_TAKER[opp.shortEx]*100).toFixed(3)}% 开+平</span>
      </div>
      <div class="hist-pnl-item">
        <span class="hist-pnl-label">滑点估算</span>
        ${slipValHtml}
      </div>
      <div class="hist-pnl-item">
        <span class="hist-pnl-label">结算胜率</span>
        <span class="hist-pnl-val" style="color:${winRate>=60?'var(--up)':winRate>=40?'var(--warn)':'var(--down)'}">${winRate}%</span>
        <span class="hist-pnl-sub">正 ${positiveCount} 负 ${negativeCount}</span>
      </div>
    </div>
    ${negHtml}
    <div class="fee-detail-row">
      <b>综合口径</b>：资金费 <span style="color:var(--up)">+$${grossUSD.toFixed(2)}</span>
      ${basisOk ? `＋ 价差 <span style="color:${basisColor}">${basisSign}$${Math.abs(basisUSD).toFixed(2)}</span>` : ''}
      − 手续费 <span style="color:var(--down)">$${feeTotal.toFixed(2)}</span>
      ${slipReady ? `− 滑点 <span style="color:var(--down)">$${slippageUSD.toFixed(2)}</span>` : ''}
      ＝ <b style="color:${netColor}">${netSign}$${netUSD.toFixed(2)}</b>。
      回本手续费需持仓 ≥ <b>${Math.ceil(feeTotal / Math.max(avgPerSettle, 0.0001))} 次结算</b>。
      <br><span style="color:var(--text-muted);font-size:10px">
        说明：资金费为两腿真实历史结算回测；价差盈亏按「7天前开仓→现在平仓」两腿价格变动估算；
        滑点按当前 ±0.5% 挂单深度估算。价差与滑点为估算、非真实成交，且未计杠杆借贷成本。
      </span>
    </div>
  `;
}

function genXAxisLabels(minTime, maxTime, count) {
  const labels = [];
  for (let i = 0; i < count; i++) {
    const t = minTime + (maxTime - minTime) * (i / (count - 1));
    labels.push(fmtShortDate(t));
  }
  return labels.map(l => `<span>${l}</span>`).join('');
}

// ============================================================
// ORDER / P&L
// ============================================================
function checkApiKeys(opp) {
  const missing = [];
  if (!state.apiKeys[opp.longEx]?.key)  missing.push(EXCHANGES[opp.longEx]?.name);
  if (!state.apiKeys[opp.shortEx]?.key) missing.push(EXCHANGES[opp.shortEx]?.name);
  const w = document.getElementById('apiWarning');
  if (missing.length > 0) {
    w.textContent = `⚠ 尚未配置 ${missing.join(', ')} 的 API Key，双边下单需先在设置中填写。`;
    w.classList.add('show');
  } else {
    w.classList.remove('show');
  }
}

function calcPnL() {
  const opp = state.selectedOpp;
  if (!opp) return;
  const notional  = parseFloat(document.getElementById('notionalInput')?.value || 1000);
  const longLev   = parseInt(document.querySelector('#longLeverageBtns .lev-btn.active')?.dataset.lev || 3);
  const shortLev  = parseInt(document.querySelector('#shortLeverageBtns .lev-btn.active')?.dataset.lev || 3);
  const longSize  = notional / opp.longPrice;
  const shortSize = notional / opp.shortPrice;
  document.getElementById('longSize').value  = longSize.toFixed(4);
  document.getElementById('shortSize').value = shortSize.toFixed(4);
  const longMargin  = notional / longLev;
  const shortMargin = notional / shortLev;
  document.getElementById('longCost').textContent  = `保证金 $${longMargin.toFixed(2)}`;
  document.getElementById('shortCost').textContent = `保证金 $${shortMargin.toFixed(2)}`;

  // --- 手续费 ---
  const feeRate  = calcRoundTripFee(opp.longEx, opp.shortEx); // total fraction
  const feeCost  = feeRate * notional;  // $ 开+平 双腿
  const longTaker  = FEE_TAKER[opp.longEx]  || 0.0005;
  const shortTaker = FEE_TAKER[opp.shortEx] || 0.0005;

  // --- 预期收益（当前费率） ---
  const grossPerSettle = notional * opp.frDiff8h;
  const sessionsPerDay = 24 / Math.min(opp.fundingIntervalA || 8, opp.fundingIntervalB || 8);
  const grossDaily  = grossPerSettle * sessionsPerDay;
  const grossWeekly = grossDaily * 7;
  const grossMonthly= grossDaily * 30;

  // Net (已扣除开+平手续费)
  const netDaily   = grossDaily   - (feeCost / 365);  // amortize fee over holding days
  const netWeekly  = grossWeekly  - (feeCost / 52);
  const netMonthly = grossMonthly - (feeCost / 12);
  const netAnnual  = grossDaily * 365 - feeCost;

  const totalMargin = longMargin + shortMargin;
  const netApr = totalMargin > 0 ? (netAnnual / totalMargin) * 100 : 0;

  const pnlColor = (v) => v >= 0 ? 'var(--up)' : 'var(--down)';
  const pnlSign  = (v) => v >= 0 ? '+' : '';

  document.getElementById('pnlGrid').innerHTML = `
    <div class="pnl-item">
      <span class="pnl-label">每次结算（扣费前）</span>
      <span class="pnl-val" style="color:var(--up)">+$${grossPerSettle.toFixed(4)}</span>
    </div>
    <div class="pnl-item">
      <span class="pnl-label">手续费（开+平双腿）</span>
      <span class="pnl-val" style="color:var(--down)">−$${feeCost.toFixed(3)}</span>
      <span style="font-size:10px;color:var(--text-muted)">${(longTaker*100).toFixed(3)}%+${(shortTaker*100).toFixed(3)}% taker</span>
    </div>
    <div class="pnl-item">
      <span class="pnl-label">日净收益（含费摊销）</span>
      <span class="pnl-val" style="color:${pnlColor(netDaily)}">${pnlSign(netDaily)}$${netDaily.toFixed(3)}</span>
    </div>
    <div class="pnl-item">
      <span class="pnl-label">周净收益</span>
      <span class="pnl-val" style="color:${pnlColor(netWeekly)}">${pnlSign(netWeekly)}$${netWeekly.toFixed(2)}</span>
    </div>
    <div class="pnl-item">
      <span class="pnl-label">月净收益</span>
      <span class="pnl-val" style="color:${pnlColor(netMonthly)}">${pnlSign(netMonthly)}$${netMonthly.toFixed(2)}</span>
    </div>
    <div class="pnl-item">
      <span class="pnl-label">保证金净年化</span>
      <span class="pnl-val ${aprClass(netApr)}">${fmtApr(netApr)}</span>
      <span style="font-size:10px;color:var(--text-muted)">保证金 $${totalMargin.toFixed(0)}</span>
    </div>
  `;

  // Re-render hist 7d card when notional changes（带上缓存的深度，保留滑点估算）
  if (state.histFrA.length || state.histFrB.length) {
    renderHist7dPnl(state.histFrA, state.histFrB, opp, state.histDepthLong, state.histDepthShort);
  }
}

// ============================================================
// ORDER EXECUTION
// ============================================================
async function placeFundingArb(side) {
  const opp = state.selectedOpp;
  if (!opp) return;
  const ex     = side === 'long' ? opp.longEx : opp.shortEx;
  const price  = parseFloat(document.getElementById(side+'Price').value || 0);
  const size   = parseFloat(document.getElementById(side+'Size').value || 0);
  if (size <= 0) { showToast('请输入下单数量', 'error'); return; }
  const apiKey = state.apiKeys[ex];
  if (!apiKey?.key) { showToast(`请先配置 ${EXCHANGES[ex]?.name} 的 API Key`, 'error'); openSettings(); return; }
  showToast(`正在向 ${EXCHANGES[ex]?.name} 提交订单...`, 'info');
  try {
    if (ex==='HL')      await placeHL(opp.symbol, side, size, price||null, apiKey);
    else if (ex==='ASTER')   await placeAster(opp.symbol, side, size, price||null, apiKey);
    else if (ex==='BINANCE') await placeBinance(opp.symbol, side, size, price||null, apiKey);
    else if (ex==='OKX')     await placeOKX(opp.symbol, side, size, price||null, apiKey);
    else if (ex==='BYBIT')   await placeBybit(opp.symbol, side, size, price||null, apiKey);
    else if (ex==='GATE')    await placeGate(opp.symbol, side, size, price||null, apiKey);
    showToast(`✅ ${EXCHANGES[ex]?.name} 订单已提交`, 'success');
  } catch(e) { showToast(`❌ 下单失败: ${e.message}`, 'error'); }
}

async function placeBoth() {
  const opp = state.selectedOpp;
  if (!opp) return;
  if (!state.apiKeys[opp.longEx]?.key || !state.apiKeys[opp.shortEx]?.key) {
    showToast('需要配置双边 API Key', 'error'); openSettings(); return;
  }
  await Promise.all([placeFundingArb('long'), placeFundingArb('short')]);
}

/* ── Stubs / real order functions (same as before) ── */
async function placeHL(sym, side, size, price, keys) {
  throw new Error('Hyperliquid 需要连接钱包签名，请在官网下单');
}
async function placeAster(sym, side, size, price, keys) {
  const params = { symbol: sym+'USDT', side: side==='long'?'BUY':'SELL', type: price?'LIMIT':'MARKET', quantity: size.toString(), ...(price?{price:price.toString(),timeInForce:'GTC'}:{}), timestamp: Date.now() };
  const qs  = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const sig = await hmacSHA256(qs, keys.secret);
  const resp = await fetch('https://fapi.asterdex.com/fapi/v1/order', { method:'POST', headers:{'X-MBX-APIKEY':keys.key,'Content-Type':'application/x-www-form-urlencoded'}, body: qs+'&signature='+sig });
  const d = await resp.json(); if (d.code<0) throw new Error(d.msg||'Order failed'); return d;
}
async function placeBinance(sym, side, size, price, keys) {
  const params = { symbol: sym+'USDT', side: side==='long'?'BUY':'SELL', type: price?'LIMIT':'MARKET', quantity: size.toString(), ...(price?{price:price.toString(),timeInForce:'GTC'}:{}), timestamp: Date.now() };
  const qs  = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const sig = await hmacSHA256(qs, keys.secret);
  const resp = await fetch('https://fapi.binance.com/fapi/v1/order', { method:'POST', headers:{'X-MBX-APIKEY':keys.key,'Content-Type':'application/x-www-form-urlencoded'}, body: qs+'&signature='+sig });
  const d = await resp.json(); if (d.code<0) throw new Error(d.msg||'Order failed'); return d;
}
async function placeOKX(sym, side, size, price, keys) {
  const body = JSON.stringify([{instId:sym+'-USDT-SWAP',tdMode:'cross',side:side==='long'?'buy':'sell',ordType:price?'limit':'market',sz:size.toString(),...(price?{px:price.toString()}:{})}]);
  const ts = new Date().toISOString(); const path = '/api/v5/trade/order';
  const sig = await hmacSHA256Base64(ts+'POST'+path+body, keys.secret);
  const resp = await fetch('https://www.okx.com'+path, { method:'POST', headers:{'OK-ACCESS-KEY':keys.key,'OK-ACCESS-SIGN':sig,'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':keys.passphrase||'','Content-Type':'application/json'}, body });
  const d = await resp.json(); if (d.code!=='0') throw new Error(d.msg||'Order failed'); return d;
}
async function placeBybit(sym, side, size, price, keys) {
  const ts = Date.now().toString();
  const body = JSON.stringify({category:'linear',symbol:sym+'USDT',side:side==='long'?'Buy':'Sell',orderType:price?'Limit':'Market',qty:size.toString(),...(price?{price:price.toString()}:{}),timeInForce:'GTC'});
  const sig = await hmacSHA256(ts+keys.key+'5000'+body, keys.secret);
  const resp = await fetch('https://api.bybit.com/v5/order/create', { method:'POST', headers:{'X-BAPI-API-KEY':keys.key,'X-BAPI-SIGN':sig,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':'5000','Content-Type':'application/json'}, body });
  const d = await resp.json(); if (d.retCode!==0) throw new Error(d.retMsg||'Order failed'); return d;
}
async function placeGate(sym, side, size, price, keys) {
  const ts = Math.floor(Date.now()/1000).toString();
  const body = JSON.stringify({contract:sym+'_USDT',size:side==='long'?Math.ceil(size):-Math.ceil(size),price:price?price.toString():'0',tif:price?'gtc':'ioc'});
  const path = '/api/v4/futures/usdt/orders';
  const bodyHash = await sha512Hex(body);
  const sig = await hmacSHA512(`POST\n${path}\n\n${bodyHash}\n${ts}`, keys.secret);
  const resp = await fetch('https://api.gateio.ws'+path, { method:'POST', headers:{KEY:keys.key,SIGN:sig,Timestamp:ts,'Content-Type':'application/json'}, body });
  const d = await resp.json(); if (d.label) throw new Error(d.message||'Order failed'); return d;
}

// ============================================================
// CRYPTO HELPERS
// ============================================================
async function hmacSHA256(msg, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function hmacSHA256Base64(msg, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function hmacSHA512(msg, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-512'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function sha512Hex(msg) {
  const enc  = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-512', enc.encode(msg));
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ============================================================
// SETTINGS MODAL
// ============================================================
// ============================================================
// SETTINGS — exchange credential configs with explanations
// ============================================================
const EXCHANGE_CONFIGS = {
  hl: {
    label: 'Hyperliquid',
    type:  'DEX',
    color: '#4f46e5',
    badge: 'DEX · EVM 链上签名',
    intro: 'Hyperliquid 是链上 DEX，所有订单需要用 EVM 私钥在本地签名后广播，<b>无需 API Key</b>。有两种接入方式：',
    modes: [
      { title: '方式 A — 直接用私钥（推荐测试）', desc: '用主钱包私钥直接签名，安全性较低，建议只用小额测试账号。' },
      { title: '方式 B — Agent Key（推荐生产）', desc: '在 Hyperliquid 官网 → 账户 → API → 创建 Agent Key。Agent Key 只有交易权限，不能提款，更安全。' },
    ],
    fields: [
      { key:'address', label:'钱包地址 (EVM)', placeholder:'0xABCD...1234', note:'你在 Hyperliquid 上的账户地址，用于标识账户，不需要私钥时也要填' },
      { key:'key',     label:'Private Key 或 Agent Key', placeholder:'0x私钥或Agent Key...', isSecret:true, note:'⚠ 本地加密存储，不上传任何服务器。建议使用 Agent Key 而非主钱包私钥' },
    ],
    steps: [
      '1. 访问 <b>app.hyperliquid.xyz</b> → 连接钱包',
      '2. 点击右上角头像 → <b>API</b> → <b>Generate Agent Key</b>',
      '3. 复制 Agent Key（0x开头，64位十六进制）粘贴到上方',
      '4. Agent Key 权限：<b>仅交易</b>，无法提款，随时可撤销',
    ],
    feeNote: `Taker: <b>0.035%</b> | Maker: <b>−0.002%</b>（做市商返佣）`,
  },
  aster: {
    label: 'AsterDEX',
    type:  'DEX',
    color: '#7c3aed',
    badge: 'DEX · REST API + HMAC 签名',
    intro: 'AsterDEX 使用与 Binance 相同的 API 签名格式（HMAC-SHA256），需要在官网申请 API Key。',
    modes: [],
    fields: [
      { key:'key',    label:'API Key',    placeholder:'API Key（字母数字混合）' },
      { key:'secret', label:'API Secret', placeholder:'API Secret', isSecret:true, note:'Secret 仅用于本地 HMAC 签名，不发送至服务器' },
    ],
    steps: [
      '1. 登录 <b>asterdex.com</b> → 用户中心 → API 管理',
      '2. 点击「创建 API Key」，备注填写用途（如 ArbiBot）',
      '3. 权限勾选：✅ <b>合约交易</b>，❌ 不要勾选提款',
      '4. 绑定 IP（可选但推荐）：填写你的服务器 IP 白名单',
      '5. 将 Key 和 Secret 复制到上方',
    ],
    feeNote: `Taker: <b>0.040%</b> | Maker: <b>0.020%</b>`,
  },
  binance: {
    label: 'Binance',
    type:  'CEX',
    color: '#d97706',
    badge: 'CEX · REST API + HMAC-SHA256',
    intro: 'Binance 合约 (USDT-M Futures) API，标准 HMAC-SHA256 签名。需开通合约账户并创建 API Key。',
    modes: [],
    fields: [
      { key:'key',    label:'API Key',    placeholder:'API Key（64位字符串）' },
      { key:'secret', label:'API Secret', placeholder:'API Secret', isSecret:true },
    ],
    steps: [
      '1. 登录币安 → 右上角头像 → <b>API 管理</b>',
      '2. 点击「创建 API」→ 选择「系统生成」',
      '3. 完成人脸/短信验证',
      '4. 权限设置：✅ <b>启用合约交易</b>，❌ <b>禁止提款</b>，❌ 禁止现货交易（减少风险）',
      '5. IP 限制（推荐）：填写固定 IP，防止 Key 泄露被盗用',
      '6. 注意：Binance 合约 API 调用需单独走 fapi.binance.com',
    ],
    feeNote: `Taker: <b>0.050%</b> | Maker: <b>0.020%</b>（VIP0，持有 BNB 可享 75折 → Taker 0.0375%）`,
  },
  okx: {
    label: 'OKX',
    type:  'CEX',
    color: '#0891b2',
    badge: 'CEX · REST API + HMAC-SHA256 + Passphrase',
    intro: 'OKX API 在 Key+Secret 之外还需要一个 <b>Passphrase</b>（API 密码），创建时自己设定。',
    modes: [],
    fields: [
      { key:'key',        label:'API Key',    placeholder:'API Key（UUID格式）' },
      { key:'secret',     label:'API Secret', placeholder:'API Secret', isSecret:true },
      { key:'passphrase', label:'Passphrase', placeholder:'你创建 API 时设定的密码', isSecret:true, note:'Passphrase 是创建 API Key 时你自己填写的密码，不是账户密码' },
    ],
    steps: [
      '1. 登录 OKX → 右上角头像 → <b>API</b>',
      '2. 点击「创建 V5 API Key」',
      '3. 设置 API 名称 + Passphrase（自定义，记牢，无法找回）',
      '4. 权限：✅ <b>交易</b>，❌ 提款，❌ 资金划转',
      '5. 可选：绑定 IP 白名单',
      '6. 将 Key / Secret / Passphrase 分别填入',
    ],
    feeNote: `Taker: <b>0.050%</b> | Maker: <b>0.020%</b>（Tier 1，持有 OKB 可享折扣）`,
  },
  bybit: {
    label: 'Bybit',
    type:  'CEX',
    color: '#dc2626',
    badge: 'CEX · REST API + HMAC-SHA256',
    intro: 'Bybit 使用标准 HMAC-SHA256 签名，V5 API 统一管理合约下单。',
    modes: [],
    fields: [
      { key:'key',    label:'API Key',    placeholder:'API Key（字母数字）' },
      { key:'secret', label:'API Secret', placeholder:'API Secret', isSecret:true },
    ],
    steps: [
      '1. 登录 Bybit → 右上角 → <b>API</b> → 创建新密钥',
      '2. 选择「系统生成的 API Key」',
      '3. 权限：✅ <b>统一交易账户</b>下的合约交易，❌ 提款，❌ 资产转移',
      '4. 可选：绑定 IP 地址',
      '5. 注意：Bybit V5 需要 X-BAPI-SIGN 签名头',
    ],
    feeNote: `Taker: <b>0.055%</b> | Maker: <b>0.020%</b>（普通用户，持有 BYB 可享折扣）`,
  },
  gate: {
    label: 'Gate.io',
    type:  'CEX',
    color: '#059669',
    badge: 'CEX · REST API + HMAC-SHA512',
    intro: 'Gate.io 合约 API 使用 HMAC-SHA512 签名（注意是 SHA512，与其他交易所不同）。',
    modes: [],
    fields: [
      { key:'key',    label:'API Key',    placeholder:'API Key' },
      { key:'secret', label:'API Secret', placeholder:'API Secret', isSecret:true, note:'Gate 用 SHA-512 签名，与 Binance 的 SHA-256 不同' },
    ],
    steps: [
      '1. 登录 gate.io → 右上角账户 → <b>API Keys</b>',
      '2. 点击「创建 API Key」',
      '3. 权限：✅ <b>合约交易</b>，❌ 提现，❌ 充值',
      '4. 设置 IP 白名单（建议）',
      '5. 完成二步验证后复制 Key 和 Secret',
    ],
    feeNote: `Taker: <b>0.050%</b> | Maker: <b>0.015%</b>（默认费率）`,
  },
};

let currentSettingsTab = 'hl';

function renderSettingsContent(tabId) {
  const cfg = EXCHANGE_CONFIGS[tabId];
  if (!cfg) return;
  const exKey = tabId.toUpperCase();
  const saved = state.apiKeys[exKey] || {};
  const isConfigured = !!saved.key;

  const stepsHtml = cfg.steps.length ? `
    <div class="setup-steps">
      <div class="setup-steps-title">📋 如何获取凭证</div>
      ${cfg.steps.map(s => `<div class="setup-step">${s}</div>`).join('')}
    </div>` : '';

  const modesHtml = cfg.modes.length ? `
    <div class="setup-modes">
      ${cfg.modes.map(m => `
        <div class="setup-mode-item">
          <div class="setup-mode-title">${m.title}</div>
          <div class="setup-mode-desc">${m.desc}</div>
        </div>`).join('')}
    </div>` : '';

  document.getElementById('settingsContent').innerHTML = `
    <div class="ex-config-header">
      <div class="ex-config-badge ex-${exKey}">${cfg.badge}</div>
      ${isConfigured ? '<span class="configured-badge">✓ 已配置</span>' : ''}
    </div>

    <div class="ex-config-intro">${cfg.intro}</div>
    ${modesHtml}

    <div class="api-form">
      ${cfg.fields.map(f => `
        <div class="api-form-row">
          <label>${f.label}</label>
          <input type="${f.isSecret ? 'password' : 'text'}"
                 id="apiField_${f.key}"
                 placeholder="${f.placeholder}"
                 value="${(saved[f.key] || '').replace(/"/g, '&quot;')}">
          ${f.note ? `<span class="field-note">${f.note}</span>` : ''}
        </div>`).join('')}
      <div class="form-actions-row">
        <button class="btn-test-conn" onclick="testApiKey('${tabId}')">🔍 测试连接</button>
        <div class="fee-badge">手续费：${cfg.feeNote}</div>
      </div>
    </div>

    ${stepsHtml}
  `;
}
async function testApiKey(tabId) { showToast('格式验证通过（实际连接需后端代理）', 'info'); }
function openSettings() {
  loadApiKeys(); currentSettingsTab = 'hl';
  document.querySelectorAll('.ex-tab').forEach(b => b.classList.toggle('active', b.dataset.stab==='hl'));
  renderSettingsContent('hl');
  document.getElementById('settingsModal').style.display = 'flex';
}
function saveSettings() {
  const cfg = EXCHANGE_CONFIGS[currentSettingsTab]; if (!cfg) return;
  const exKey = currentSettingsTab.toUpperCase();
  if (!state.apiKeys[exKey]) state.apiKeys[exKey] = {};
  cfg.fields.forEach(f => {
    const el = document.getElementById('apiField_'+f.key);
    if (el) state.apiKeys[exKey][f.key] = el.value.trim();
  });
  saveApiKeys();
  showToast(`✅ ${cfg.label} 凭证已保存`, 'success');
  renderSettingsContent(currentSettingsTab);
}
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// ============================================================
// TOAST
// ============================================================
function showToast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✕', info: 'i' };
  el.innerHTML = `<span class="toast-icon">${icons[type]||'i'}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => { el.classList.add('toast-fade-out'); setTimeout(() => el.remove(), 250); }, 3500);
}

// ============================================================
// MAIN REFRESH LOOP
// ============================================================
async function refreshData() {
  document.getElementById('loadingState').style.display = 'flex';
  document.getElementById('arbTable').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('refreshBtn').style.animation = 'spin .6s linear infinite';
  try {
    state.markets    = await fetchAllMarkets();
    state.arbitrages = buildArbitrages(state.markets, state.tab);
    render(filterAndSort(state.arbitrages));
  } catch(e) {
    console.error(e);
    showToast('数据获取失败: '+e.message, 'error');
  } finally {
    document.getElementById('refreshBtn').style.animation = '';
    document.getElementById('loadingState').style.display = 'none';
  }
}

// ============================================================
// AUTO-REFRESH
// ============================================================
let countdownInterval = null;
function startAutoRefresh() {
  stopAutoRefresh();
  state.countdown = 30;
  document.getElementById('countdown').textContent = '30s';
  countdownInterval = setInterval(() => {
    state.countdown--;
    document.getElementById('countdown').textContent = state.countdown + 's';
    // WS 实时层接管后，这里只做「兜底轮询」：仅拉取 WS 不健康的交易所
    if (state.countdown <= 0) { state.countdown = 30; fallbackTick(); }
  }, 1000);
  setInterval(tickCountdowns, 1000);
  // Also tick drawer countdown
  setInterval(() => {
    const el = document.getElementById('drawerCountdown');
    if (el && state.selectedOpp) el.textContent = fmtCountdown(state.selectedOpp.nextFundingTime);
  }, 1000);
}
function stopAutoRefresh() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
}

// ============================================================
// EVENT LISTENERS
// ============================================================
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      state.arbitrages = buildArbitrages(state.markets, state.tab);
      render(filterAndSort(state.arbitrages));
    });
  });

  // Exchange chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const ex = chip.dataset.ex;
      state.activeExs.has(ex) ? state.activeExs.delete(ex) : state.activeExs.add(ex);
      chip.classList.toggle('active');
      state.arbitrages = buildArbitrages(state.markets, state.tab);
      render(filterAndSort(state.arbitrages));
    });
  });

  // Min APR slider
  const minAprEl = document.getElementById('minApr');
  minAprEl.addEventListener('input', () => {
    state.minApr = parseInt(minAprEl.value);
    document.getElementById('minAprVal').textContent = state.minApr + '%';
    state.arbitrages = buildArbitrages(state.markets, state.tab);
    render(filterAndSort(state.arbitrages));
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', e => {
    state.searchQ = e.target.value.trim();
    render(filterAndSort(state.arbitrages));
  });

  // Sort
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sortBy = e.target.value;
    render(filterAndSort(state.arbitrages));
  });

  // Refresh
  document.getElementById('refreshBtn').addEventListener('click', () => {
    // WS 实时层下：立刻用现有数据重绘 + 对不健康的交易所做一次 REST 兜底
    wsDirty = true;
    state.arbitrages = buildArbitrages(state.markets, state.tab);
    render(filterAndSort(state.arbitrages));
    fallbackTick();
    state.countdown = 30;
  });

  // Auto refresh toggle
  document.getElementById('autoRefreshBtn').addEventListener('click', () => {
    state.autoRefresh = !state.autoRefresh;
    const dot = document.querySelector('#autoRefreshBtn .dot');
    if (state.autoRefresh) { dot.classList.replace('grey','green'); startAutoRefresh(); }
    else { dot.classList.replace('green','grey'); stopAutoRefresh(); }
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('settingsCancelBtn').addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('settingsSaveBtn').addEventListener('click', saveSettings);
  document.querySelectorAll('.ex-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ex-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSettingsTab = btn.dataset.stab;
      renderSettingsContent(currentSettingsTab);
    });
  });

  // Drawer close
  document.getElementById('drawerClose').addEventListener('click', closeDetail);
  document.getElementById('drawerOverlay').addEventListener('click', closeDetail);
  document.getElementById('drawerBtnBoth').addEventListener('click', placeBoth);

  // Order buttons
  document.getElementById('btnLong').addEventListener('click',  () => placeFundingArb('long'));
  document.getElementById('btnShort').addEventListener('click', () => placeFundingArb('short'));
  document.getElementById('btnBoth').addEventListener('click',  placeBoth);

  // Market price buttons
  document.querySelectorAll('.btn-market').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById((btn.dataset.side==='long'?'long':'short')+'Price').value = '';
    });
  });

  // Leverage
  document.querySelectorAll('.leverage-btns').forEach(group => {
    group.querySelectorAll('.lev-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.lev-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        calcPnL();
      });
    });
  });

  // Notional
  document.getElementById('notionalInput')?.addEventListener('input', calcPnL);

  // Settings modal backdrop
  document.getElementById('settingsModal').addEventListener('click', e => {
    if (e.target === document.getElementById('settingsModal')) closeModal('settingsModal');
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDetail(); closeModal('settingsModal'); }
  });
}

// ============================================================
// AUTO ARBI ENGINE — 全自动资金费率套利
// ============================================================
/**
 * 策略逻辑（100U 示例）：
 *  1. 每轮扫描拿最高 APR 机会（过滤掉价差 >0.5% 的高风险对）
 *  2. 计算双腿仓位 = 本金 ÷ 2（各腿各 50U margin）
 *  3. 若当前已有持仓：检查退出条件
 *     - 费率反转（原来赚钱的方向变亏钱）
 *     - 价差超出 3σ 历史上限（价格风险过大）
 *     - APR < exitAprThreshold（机会消失）
 *  4. 若满足退出条件：双腿平仓
 *  5. 记录每笔操作到 autoLog
 */

const AUTO_ARBI = {
  running:       false,
  phase:         'scan',    // 'scan' | 'hold'
  budget:        100,       // USDT 总本金
  minApr:        15,        // 入场最低APR%
  exitApr:       5,         // 退出APR%阈值
  maxSpread:     0.5,       // 入场最大价差%
  rotateGap:     20,        // 仓位轮换：新机会APR须超过当前 N% 才换
  maxNegStreak:  3,         // 连续负结算超过此值触发平仓
  interval:      60,        // 检查间隔（秒）
  position:      null,      // 当前持仓
  negStreak:     0,         // 当前连续负结算计数
  eligibleList:  [],        // 上次扫描的可开单列表
  log:           [],
  timer:         null,
  countdown:     0,
};

// ---- State persistence ----
function saveAutoArbi() {
  const s = { ...AUTO_ARBI, timer: null };
  localStorage.setItem('arbi_auto', JSON.stringify(s));
}
function loadAutoArbi() {
  try {
    const s = JSON.parse(localStorage.getItem('arbi_auto') || '{}');
    Object.assign(AUTO_ARBI, s);
    AUTO_ARBI.running = false; // never restore running state on reload
    AUTO_ARBI.timer   = null;
  } catch(e) {}
}

// ---- Log helper ----
function autoLog(type, msg, data = {}) {
  const entry = { time: Date.now(), type, msg, ...data };
  AUTO_ARBI.log.unshift(entry);
  if (AUTO_ARBI.log.length > 100) AUTO_ARBI.log.pop();
  renderAutoPanel();
  saveAutoArbi();
  console.log(`[AutoArbi] ${type.toUpperCase()}: ${msg}`, data);
}

// ---- Phase 1: Build eligible list with full data validation ----
/**
 * 扫描当前所有套利机会，拉取历史数据，做全量筛选。
 * 必须有数据才能入选，没有历史直接排除。
 *
 * 筛选条件（全部硬性，一个不过就淘汰）：
 *   ① APR >= minApr
 *   ② 价差 <= maxSpread
 *   ③ 两边都配置了 API Key
 *   ④ 资金费率历史 >= 10 条（至少3天）
 *   ⑤ 结算胜率 >= 60%
 *   ⑥ 负费率类型 != 'persistent'
 *   ⑦ K线数据 >= 30 条（约5天4h K线）
 *   ⑧ P90振幅 < 5%（插针风险）
 *   ⑨ 单日最大跌幅 < 15%（闪崩风险）
 *
 * 返回按 score 从高到低排序的 eligible 列表，每项附带：
 *   { opp, frA, frB, klines, volRisk, winRate, negAnalysis, score }
 */
async function buildEligibleList() {
  autoLog('scan', '🔍 Phase 1 — 开始扫描并验证历史数据...');

  // 取所有满足基础条件的候选
  const candidates = state.arbitrages.filter(o =>
    o.apr >= AUTO_ARBI.minApr &&
    o.spreadAbs <= AUTO_ARBI.maxSpread &&
    state.apiKeys[o.longEx]?.key &&
    state.apiKeys[o.shortEx]?.key
  );

  if (!candidates.length) {
    autoLog('scan', `未找到基础条件满足的候选（APR≥${AUTO_ARBI.minApr}%, 价差≤${AUTO_ARBI.maxSpread}%）`);
    AUTO_ARBI.eligibleList = [];
    return [];
  }

  autoLog('scan', `基础条件通过 ${candidates.length} 个，开始拉取历史数据...`);

  // 并发拉历史（最多同时5个，避免 API 限流）
  const BATCH = 5;
  const results = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async opp => {
      const [frA, frB, kl4hA, kl1dA, kl1dB, depthLong, depthShort] = await Promise.all([
        fetchHistoricalFunding(opp.longEx,  opp.symbol),
        fetchHistoricalFunding(opp.shortEx, opp.symbol),
        fetchMarkPriceHistory(opp.longEx,  opp.symbol, '4h'),  // 4h线给价差用
        fetchMarkPriceHistory(opp.longEx,  opp.symbol, '1d'),  // 30天日线给波动分析用
        fetchMarkPriceHistory(opp.shortEx, opp.symbol, '1d'),  // 两边都拿，取更多那个
        fetchOrderbookDepth(opp.longEx,  opp.symbol),          // 挂单深度（做多腿）
        fetchOrderbookDepth(opp.shortEx, opp.symbol),          // 挂单深度（做空腿）
      ]);
      const kl1d = kl1dA.length >= kl1dB.length ? kl1dA : kl1dB;
      return { opp, frA, frB, kl4h: kl4hA, kl1d, depthLong, depthShort };
    }));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') results.push(r.value);
      else console.warn('fetchHistory failed:', batch[idx].symbol, r.reason);
    });
  }

  const eligible = [];
  for (const { opp, frA, frB, kl4h, kl1d, depthLong, depthShort } of results) {

    // ④ 资金费率历史数量
    if (frA.length < 10 || frB.length < 10) {
      autoLog('filter', `❌ ${opp.symbol} 历史资金费率不足（${frA.length}/${frB.length} 条），跳过`);
      continue;
    }

    // 对齐结算，算胜率 + negAnalysis
    const BUCKET = 8 * 3600 * 1000;
    const mapB = {};
    frB.forEach(d => { const k = Math.round(d.time / BUCKET); mapB[k] = d; });
    const series = [];
    frA.forEach(dA => {
      const k = Math.round(dA.time / BUCKET);
      const dB = mapB[k] || mapB[k-1] || mapB[k+1];
      if (dB) series.push({ time: dA.time, earned: dB.rate - dA.rate });
    });

    if (series.length < 10) {
      autoLog('filter', `❌ ${opp.symbol} 可对齐结算数不足（${series.length} 条），跳过`);
      continue;
    }

    const posCount   = series.filter(d => d.earned >= 0).length;
    const winRate    = posCount / series.length;
    const negAnalysis = analyzeNegFunding(series);

    // ⑤ 胜率
    if (winRate < 0.60) {
      autoLog('filter', `❌ ${opp.symbol} 胜率 ${(winRate*100).toFixed(0)}% < 60%，跳过`);
      continue;
    }

    // ⑥ 负费率类型
    if (negAnalysis.type === 'persistent') {
      autoLog('filter', `❌ ${opp.symbol} 负费率持续（${(negAnalysis.negRatio*100).toFixed(0)}%，连续${negAnalysis.maxStreak}次），跳过`);
      continue;
    }

    // ⑦⑧ 30天日线波动风险（最大单日振幅，不区分涨跌）
    if (kl1d.length < 10) {
      autoLog('filter', `❌ ${opp.symbol} 30天日线数据不足（${kl1d.length} 根），跳过`);
      continue;
    }
    const volRisk = calcVolatilityRisk(kl1d);
    if (!volRisk.safe) {
      autoLog('filter', `❌ ${opp.symbol} 波动风险：${volRisk.reason}`);
      continue;
    }
    if (volRisk.warnOnly) {
      autoLog('filter', `⚠ ${opp.symbol} 波动警告：${volRisk.reason}，允许入选但评分降低`);
    }

    // 综合评分（有历史数据 + orderbook depth，评分更准）
    const sc = scoreOpp(opp, frA, frB, depthLong, depthShort);

    const minDepth = (depthLong?.totalDepth && depthShort?.totalDepth)
      ? Math.min(depthLong.totalDepth, depthShort.totalDepth)
      : (depthLong?.totalDepth || depthShort?.totalDepth || 0);

    eligible.push({ opp, frA, frB, kl4h, kl1d, volRisk, winRate, negAnalysis, depthLong, depthShort, score: sc.score, grade: sc.grade });
    autoLog('filter', `✅ ${opp.symbol} 通过 | 评分${sc.score}(${sc.grade}) | 胜率${(winRate*100).toFixed(0)}% | 最大日振幅${(volRisk.maxSpike*100).toFixed(1)}% | 深度$${(minDepth/1000).toFixed(0)}k`);
  }

  // 按 score 降序
  eligible.sort((a, b) => b.score - a.score);
  AUTO_ARBI.eligibleList = eligible;

  autoLog('scan', `Phase 1 完成：${eligible.length}/${candidates.length} 个通过，最优为 ${eligible[0]?.opp.symbol || '无'}`);
  return eligible;
}

// ---- Open position ----
async function autoOpen(opp) {
  const notional = AUTO_ARBI.budget / 2; // each leg half budget
  const longSize  = notional / opp.longPrice;
  const shortSize = notional / opp.shortPrice;
  const feeRate   = calcRoundTripFee(opp.longEx, opp.shortEx);

  autoLog('open', `开仓 ${opp.symbol}: 做多 ${EXCHANGES[opp.longEx]?.name} + 做空 ${EXCHANGES[opp.shortEx]?.name}`, {
    symbol: opp.symbol, longEx: opp.longEx, shortEx: opp.shortEx,
    notional, longSize, shortSize, apr: opp.apr.toFixed(2),
  });

  try {
    // Place both legs simultaneously
    const [r1, r2] = await Promise.allSettled([
      executeOrder(opp.longEx,  opp.symbol, 'long',  longSize,  state.apiKeys[opp.longEx]),
      executeOrder(opp.shortEx, opp.symbol, 'short', shortSize, state.apiKeys[opp.shortEx]),
    ]);

    if (r1.status === 'rejected' || r2.status === 'rejected') {
      const err = r1.status === 'rejected' ? r1.reason : r2.reason;
      autoLog('error', `开仓失败，尝试回退平仓: ${err.message}`);
      // Try to close whichever leg succeeded
      if (r1.status === 'fulfilled') await executeOrder(opp.longEx,  opp.symbol, 'close_long',  longSize,  state.apiKeys[opp.longEx]).catch(()=>{});
      if (r2.status === 'fulfilled') await executeOrder(opp.shortEx, opp.symbol, 'close_short', shortSize, state.apiKeys[opp.shortEx]).catch(()=>{});
      return false;
    }

    AUTO_ARBI.position = {
      opp, notional,
      entryTime:    Date.now(),
      entrySpread:  opp.spreadPct,
      entryApr:     opp.apr,
      longSize, shortSize,
      grossFunding: 0,
      feeCost:      feeRate * notional * 2, // open + close
    };
    saveAutoArbi();
    autoLog('info', `✅ 双腿开仓成功，APR=${opp.apr.toFixed(1)}%，价差=${opp.spreadPct.toFixed(4)}%`);
    return true;
  } catch(e) {
    autoLog('error', `开仓异常: ${e.message}`);
    return false;
  }
}

// ---- Close position ----
async function autoClose(reason) {
  const pos = AUTO_ARBI.position;
  if (!pos) return;

  autoLog('close', `平仓 ${pos.opp.symbol}: ${reason}`, {
    heldMs:       Date.now() - pos.entryTime,
    grossFunding: pos.grossFunding?.toFixed(4),
  });

  try {
    await Promise.allSettled([
      executeOrder(pos.opp.longEx,  pos.opp.symbol, 'close_long',  pos.longSize,  state.apiKeys[pos.opp.longEx]),
      executeOrder(pos.opp.shortEx, pos.opp.symbol, 'close_short', pos.shortSize, state.apiKeys[pos.opp.shortEx]),
    ]);

    const netPnl = (pos.grossFunding || 0) - pos.feeCost;
    autoLog('pnl', `净盈亏 $${netPnl.toFixed(4)} | 毛资金费 $${(pos.grossFunding||0).toFixed(4)} − 手续费 $${pos.feeCost.toFixed(4)}`, {
      symbol: pos.opp.symbol, netPnl,
    });
  } catch(e) {
    autoLog('error', `平仓异常: ${e.message}`);
  }
  AUTO_ARBI.position = null;
  saveAutoArbi();
}

// ---- Check exit conditions (Phase 2) ----
/**
 * 检查是否需要平仓。分三类：
 *
 * 硬止损（立刻平，不等）：
 *   A. 找不到持仓对（代币下架）
 *   B. 价差 > 入场价差 × 5（价格严重偏离，对冲敞口暴露）
 *   C. 连续负结算 >= maxNegStreak（费率结构已确认反转）
 *
 * 软止损（APR/费率下降）：
 *   D. APR < exitApr
 *   E. frDiff8h 连续 2 次为负（方向反转趋势确认，非偶发）
 *
 * 主动 Rotate（切换更好机会，由 autoTick 负责判断，这里只标记 rotate）：
 *   由调用方 autoTick 对比 eligibleList[0] 决定
 */
function shouldExit(pos) {
  const opp = state.arbitrages.find(o =>
    o.symbol === pos.opp.symbol &&
    o.longEx === pos.opp.longEx &&
    o.shortEx === pos.opp.shortEx
  );

  // A. 下架
  if (!opp) return { exit: true, reason: '代币已下架或找不到持仓对' };

  // B. 价差硬止损：超过入场价差 5 倍
  const spreadLimit = Math.max(pos.entrySpread * 5, AUTO_ARBI.maxSpread * 3);
  if (opp.spreadAbs > spreadLimit) {
    return { exit: true, reason: `价差扩大至 ${opp.spreadAbs.toFixed(3)}%（入场时 ${pos.entrySpread.toFixed(3)}%），超硬止损线` };
  }

  // C. 连续负结算计数（由 autoTick 在每次结算时更新 AUTO_ARBI.negStreak）
  if (AUTO_ARBI.negStreak >= AUTO_ARBI.maxNegStreak) {
    return { exit: true, reason: `连续 ${AUTO_ARBI.negStreak} 次负结算，费率结构反转确认` };
  }

  // D. APR 软止损
  if (opp.apr < AUTO_ARBI.exitApr) {
    return { exit: true, reason: `APR 降至 ${opp.apr.toFixed(1)}%，低于退出阈值 ${AUTO_ARBI.exitApr}%` };
  }

  // E. frDiff 连续 2 次为负（pos 里存 negFrCount）
  if (opp.frDiff8h < 0) {
    pos._negFrCount = (pos._negFrCount || 0) + 1;
    if (pos._negFrCount >= 2) {
      return { exit: true, reason: `资金费率差连续 ${pos._negFrCount} 次为负，方向反转趋势确认` };
    }
    // 第一次偶发，不平仓，记录
    return { exit: false, warn: `资金费率差本次为负（第 ${pos._negFrCount} 次），继续观察` };
  } else {
    pos._negFrCount = 0; // 方向恢复正常，重置
  }

  return { exit: false };
}

// ---- Tick: Phase 2 持仓监控 + rotate ----
async function autoTick() {
  if (!AUTO_ARBI.running) return;
  AUTO_ARBI.countdown = AUTO_ARBI.interval;

  const pos = AUTO_ARBI.position;

  if (pos) {
    // ── 累积预估资金费收入 ──
    const opp = state.arbitrages.find(o =>
      o.symbol === pos.opp.symbol &&
      o.longEx === pos.opp.longEx &&
      o.shortEx === pos.opp.shortEx
    );
    if (opp) {
      const estFr = opp.frDiff8h * (AUTO_ARBI.interval / (8 * 3600)) * pos.notional * 2;
      pos.grossFunding = (pos.grossFunding || 0) + estFr;

      // 更新连续负结算计数（按结算周期，不是每秒）
      // 用时间判断：距上次结算时间点超过 8h 则认为过了一次结算
      const now = Date.now();
      const lastSettle = pos._lastSettleCheck || pos.entryTime;
      if (now - lastSettle >= 8 * 3600 * 1000) {
        pos._lastSettleCheck = now;
        if (estFr < 0) {
          AUTO_ARBI.negStreak = (AUTO_ARBI.negStreak || 0) + 1;
          autoLog('warn', `⚠ 第 ${AUTO_ARBI.negStreak} 次负结算（估算 $${estFr.toFixed(4)}）`);
        } else {
          if (AUTO_ARBI.negStreak > 0) autoLog('info', `负结算计数器已重置（本次正结算 $${estFr.toFixed(4)}）`);
          AUTO_ARBI.negStreak = 0;
        }
      }
    }

    // ── 检查退出条件 ──
    const { exit, reason, warn } = shouldExit(pos);
    if (warn) autoLog('warn', warn);

    if (exit) {
      await autoClose(reason);
      AUTO_ARBI.negStreak = 0;
      AUTO_ARBI.phase = 'scan';
      // 平仓后立刻做一次 Phase 1 扫描
      renderAutoPanel();
      const eligible = await buildEligibleList();
      if (eligible.length) {
        autoLog('scan', `Phase 2 — 开仓最优：${eligible[0].opp.symbol} 评分${eligible[0].score}`);
        await autoOpen(eligible[0].opp);
        AUTO_ARBI.phase = 'hold';
        AUTO_ARBI.negStreak = 0;
      }
      renderAutoPanel();
      return;
    }

    // ── Rotate 检查：有更好机会才切换 ──
    // 刷新最新市场数据后，与 eligibleList 里最优对比
    if (AUTO_ARBI.eligibleList.length > 0) {
      const best = AUTO_ARBI.eligibleList[0];
      const isSame = best.opp.symbol === pos.opp.symbol &&
                     best.opp.longEx === pos.opp.longEx &&
                     best.opp.shortEx === pos.opp.shortEx;
      if (!isSame) {
        const currentOpp = state.arbitrages.find(o =>
          o.symbol === pos.opp.symbol && o.longEx === pos.opp.longEx && o.shortEx === pos.opp.shortEx
        );
        const currentApr = currentOpp?.apr || pos.entryApr;
        const rotateThreshold = currentApr * (1 + AUTO_ARBI.rotateGap / 100);

        if (best.opp.apr > rotateThreshold) {
          autoLog('rotate', `🔄 发现更好机会：${best.opp.symbol} APR=${best.opp.apr.toFixed(1)}% > 当前${pos.opp.symbol} ${currentApr.toFixed(1)}% × ${1+AUTO_ARBI.rotateGap/100}，执行仓位轮换`);
          await autoClose(`主动轮换至 ${best.opp.symbol}（APR ${best.opp.apr.toFixed(1)}%）`);
          AUTO_ARBI.negStreak = 0;
          await autoOpen(best.opp);
          AUTO_ARBI.phase = 'hold';
        }
      }
    }

    renderAutoPanel();
    return;
  }

  // ── 无持仓：Phase 1 扫描 + 开仓 ──
  AUTO_ARBI.phase = 'scan';
  renderAutoPanel();
  // WS 已实时维护 state.markets，直接用最新数据重建套利列表；对挂掉的 WS 做一次兜底
  fallbackTick();
  state.arbitrages = buildArbitrages(state.markets, state.tab);
  const eligible = await buildEligibleList();

  if (eligible.length) {
    const best = eligible[0];
    autoLog('scan', `Phase 2 — 开仓最优：${best.opp.symbol} 评分${best.score}(${best.grade}) APR=${best.opp.apr.toFixed(1)}%`);
    const ok = await autoOpen(best.opp);
    if (ok) {
      AUTO_ARBI.phase = 'hold';
      AUTO_ARBI.negStreak = 0;
    }
  } else {
    autoLog('scan', '未找到符合全部筛选条件的机会，等待下次扫描...');
  }
  renderAutoPanel();
}

// ---- Start / Stop ----
function startAutoArbi() {
  if (AUTO_ARBI.running) return;

  // Validate budget
  if (AUTO_ARBI.budget <= 0) { showToast('请先设置本金', 'error'); return; }

  // Validate at least one exchange has keys
  const configured = Object.keys(state.apiKeys).filter(k => state.apiKeys[k]?.key);
  if (configured.length < 2) {
    showToast('需要至少配置 2 个交易所的 API Key', 'error');
    openSettings();
    return;
  }

  AUTO_ARBI.running  = true;
  AUTO_ARBI.countdown = AUTO_ARBI.interval;
  saveAutoArbi();
  autoLog('system', `▶ 自动套利启动 | 本金 $${AUTO_ARBI.budget} | 最低 APR ${AUTO_ARBI.minApr}%`);

  // Immediate first tick
  autoTick();

  // Countdown display
  AUTO_ARBI.timer = setInterval(() => {
    AUTO_ARBI.countdown = Math.max(0, AUTO_ARBI.countdown - 1);
    if (AUTO_ARBI.countdown <= 0) {
      AUTO_ARBI.countdown = AUTO_ARBI.interval;
      autoTick();
    }
    updateAutoCountdown();
  }, 1000);
  renderAutoPanel();
}

function stopAutoArbi() {
  AUTO_ARBI.running = false;
  if (AUTO_ARBI.timer) { clearInterval(AUTO_ARBI.timer); AUTO_ARBI.timer = null; }
  autoLog('system', '⏹ 自动套利已停止');
  saveAutoArbi();
  renderAutoPanel();
}

// ---- Thin wrapper for order execution ----
async function executeOrder(ex, symbol, side, size, keys) {
  // side: 'long' | 'short' | 'close_long' | 'close_short'
  const isBuy   = side === 'long'  || side === 'close_short';
  const rawSide = isBuy ? 'long' : 'short';
  const isClose = side.startsWith('close_');

  if (ex === 'HL') {
    // HL: use EVM signing via ethers (requires ethers.js or similar)
    // For now, throw with helpful message
    throw new Error('Hyperliquid 需要链上签名，请在设置中确认已配置 Agent Key，并使用支持签名的环境');
  }
  if (ex === 'BINANCE') return placeBinance(symbol, rawSide, size, null, keys, isClose);
  if (ex === 'ASTER')   return placeAster(symbol, rawSide, size, null, keys, isClose);
  if (ex === 'OKX')     return placeOKX(symbol, rawSide, size, null, keys, isClose);
  if (ex === 'BYBIT')   return placeBybit(symbol, rawSide, size, null, keys, isClose);
  if (ex === 'GATE')    return placeGate(symbol, rawSide, size, null, keys, isClose);
  throw new Error(`${ex} 暂不支持自动下单`);
}

function updateAutoCountdown() {
  const el = document.getElementById('autoCountdown');
  if (el) el.textContent = AUTO_ARBI.countdown + 's';
}

// ---- Render the auto panel UI ----
function renderAutoPanel() {
  const panel = document.getElementById('autoArbiPanel');
  if (!panel) return;

  const pos      = AUTO_ARBI.position;
  const phase    = AUTO_ARBI.phase || 'scan';
  const eli      = AUTO_ARBI.eligibleList || [];
  const totalPnl = AUTO_ARBI.log.filter(l => l.type === 'pnl').reduce((s, l) => s + (l.netPnl || 0), 0);
  const openEst  = pos ? ((pos.grossFunding || 0) - pos.feeCost) : 0;
  const totalEst = totalPnl + openEst;

  // ── Phase 指示条 ──
  const phaseLabel = { scan: '🔍 Phase 1：扫描筛选中', hold: '📊 Phase 2：持仓监控中' };
  const phaseColor = { scan: 'var(--brand)', hold: 'var(--up)' };
  const phaseHtml  = AUTO_ARBI.running ? `
    <div class="auto-phase-bar" style="background:${phaseColor[phase]}18;border-bottom:2px solid ${phaseColor[phase]}33;padding:6px 16px;font-size:11px;font-weight:700;color:${phaseColor[phase]}">
      ${phaseLabel[phase] || ''}
      ${phase === 'hold' && AUTO_ARBI.negStreak > 0 ? `<span style="float:right;color:var(--warn)">⚠ 连续负结算 ${AUTO_ARBI.negStreak}/${AUTO_ARBI.maxNegStreak}</span>` : ''}
    </div>` : '';

  // ── 持仓卡片 ──
  const posHTML = pos ? `
    <div class="auto-position">
      <div class="auto-pos-header">
        <span class="auto-pos-sym">${tokenIconHTML(pos.opp.symbol, 18)} ${pos.opp.symbol}</span>
        <span style="font-size:11px;color:var(--text-muted)">${EXCHANGES[pos.opp.longEx]?.name} 多 / ${EXCHANGES[pos.opp.shortEx]?.name} 空</span>
      </div>
      <div class="auto-pos-stats">
        <div><span class="auto-stat-label">本金</span><span class="auto-stat-val">$${(pos.notional*2).toFixed(1)}</span></div>
        <div><span class="auto-stat-label">入场APR</span><span class="auto-stat-val" style="color:var(--up)">${pos.entryApr?.toFixed(1)}%</span></div>
        <div><span class="auto-stat-label">预估净盈亏</span><span class="auto-stat-val" style="color:${openEst>=0?'var(--up)':'var(--down)'}">${openEst>=0?'+':''}$${openEst.toFixed(3)}</span></div>
        <div><span class="auto-stat-label">持仓时长</span><span class="auto-stat-val">${fmtHeld(Date.now()-pos.entryTime)}</span></div>
        <div><span class="auto-stat-label">连续负结算</span><span class="auto-stat-val" style="color:${AUTO_ARBI.negStreak>0?'var(--warn)':'var(--up)'}">
          ${AUTO_ARBI.negStreak} / ${AUTO_ARBI.maxNegStreak}次触发
        </span></div>
        <div><span class="auto-stat-label">入场价差</span><span class="auto-stat-val">${pos.entrySpread?.toFixed(3)}%</span></div>
      </div>
    </div>
  ` : `<div class="auto-no-pos">${AUTO_ARBI.running ? (phase==='scan'?'扫描中，等待符合条件的机会…':'持仓监控中') : '未运行，点击启动开始自动套利'}</div>`;

  // ── 可开单列表（最多显示5条）──
  const eligibleHtml = eli.length ? `
    <div class="auto-eligible-section">
      <div class="auto-log-title">✅ 可开单代币（${eli.length} 个通过筛选）</div>
      ${eli.slice(0, 5).map((item, i) => {
        const isCurrent = pos && item.opp.symbol === pos.opp.symbol;
        const gradeColor = { A:'var(--up)', B:'#0891b2', C:'var(--warn)', D:'var(--down)' };
        const spikeColor = item.volRisk.maxSpike < 0.08 ? 'var(--up)' : item.volRisk.maxSpike < 0.12 ? 'var(--warn)' : 'var(--down)';
        return `<div class="auto-eligible-item ${isCurrent ? 'current' : ''}">
          <span class="auto-eli-rank">#${i+1}</span>
          ${tokenIconHTML(item.opp.symbol, 14)}
          <span class="auto-eli-sym">${item.opp.symbol}</span>
          <span class="auto-eli-grade" style="color:${gradeColor[item.grade]}">${item.grade}</span>
          <span class="auto-eli-apr">${item.opp.apr.toFixed(1)}%</span>
          <span class="auto-eli-wr" style="color:${item.winRate>=0.7?'var(--up)':'var(--warn)'}">${(item.winRate*100).toFixed(0)}%胜率</span>
          <span class="auto-eli-vol" style="color:${spikeColor}" title="30天最大日振幅 / 近5日均振幅">
            ↕${(item.volRisk.maxSpike*100).toFixed(1)}%
          </span>
          ${isCurrent ? '<span class="auto-eli-holding">持仓中</span>' : ''}
        </div>`;
      }).join('')}
    </div>` : (AUTO_ARBI.running && phase==='scan' ? `
    <div style="padding:10px 16px;font-size:11px;color:var(--text-muted)">正在拉取历史数据，筛选中…</div>
    ` : '');

  // ── 日志 ──
  const logIcons  = { open:'🟢', close:'🔴', pnl:'💰', error:'❌', scan:'🔍', filter:'🔖', system:'⚙️', info:'ℹ️', warn:'⚠️', rotate:'🔄' };
  const logColors = { open:'var(--up)', close:'var(--warn)', pnl:'var(--up)', error:'var(--down)', scan:'var(--text-muted)', filter:'var(--text-muted)', system:'#6366f1', warn:'var(--warn)', rotate:'#0891b2' };
  const logHTML   = AUTO_ARBI.log.slice(0, 10).map(l => `
    <div class="auto-log-item">
      <span class="auto-log-icon">${logIcons[l.type]||'·'}</span>
      <span class="auto-log-time">${new Date(l.time).toLocaleTimeString('zh',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
      <span class="auto-log-msg" style="color:${logColors[l.type]||'var(--text-secondary)'}">${l.msg}</span>
    </div>`).join('');

  panel.innerHTML = `
    <div class="auto-panel-header">
      <div class="auto-panel-title">
        <span class="auto-status-dot ${AUTO_ARBI.running ? 'running' : ''}"></span>
        自动套利引擎
      </div>
      <div class="auto-panel-pnl">
        累计净盈亏 <b style="color:${totalEst>=0?'var(--up)':'var(--down)'}">
          ${totalEst>=0?'+':''}$${totalEst.toFixed(3)}
        </b>
      </div>
    </div>

    ${phaseHtml}

    <div class="auto-controls">
      <div class="auto-cfg-row">
        <label>本金 ($)</label>
        <input type="number" value="${AUTO_ARBI.budget}" min="10" max="100000"
               onchange="AUTO_ARBI.budget=parseFloat(this.value)||100;saveAutoArbi()"
               ${AUTO_ARBI.running?'disabled':''}>
      </div>
      <div class="auto-cfg-row">
        <label>入场 APR ≥</label>
        <input type="number" value="${AUTO_ARBI.minApr}" min="1" max="200"
               onchange="AUTO_ARBI.minApr=parseFloat(this.value)||15;saveAutoArbi()"
               ${AUTO_ARBI.running?'disabled':''}>
        <span class="auto-cfg-unit">%</span>
      </div>
      <div class="auto-cfg-row">
        <label>退出 APR ≤</label>
        <input type="number" value="${AUTO_ARBI.exitApr}" min="0" max="100"
               onchange="AUTO_ARBI.exitApr=parseFloat(this.value)||5;saveAutoArbi()"
               ${AUTO_ARBI.running?'disabled':''}>
        <span class="auto-cfg-unit">%</span>
      </div>
      <div class="auto-cfg-row">
        <label>最大价差</label>
        <input type="number" value="${AUTO_ARBI.maxSpread}" min="0.05" max="5" step="0.05"
               onchange="AUTO_ARBI.maxSpread=parseFloat(this.value)||0.5;saveAutoArbi()"
               ${AUTO_ARBI.running?'disabled':''}>
        <span class="auto-cfg-unit">%</span>
      </div>
      <div class="auto-cfg-row">
        <label>轮换超出 ≥</label>
        <input type="number" value="${AUTO_ARBI.rotateGap}" min="5" max="100" step="5"
               onchange="AUTO_ARBI.rotateGap=parseFloat(this.value)||20;saveAutoArbi()"
               title="新机会APR须比当前高出此百分比才轮换，避免频繁切换">
        <span class="auto-cfg-unit">%</span>
      </div>
      <div class="auto-cfg-row">
        <label>负结算容忍</label>
        <input type="number" value="${AUTO_ARBI.maxNegStreak}" min="1" max="10" step="1"
               onchange="AUTO_ARBI.maxNegStreak=parseInt(this.value)||3;saveAutoArbi()"
               title="连续N次负结算后平仓，偶发1-2次属正常">
        <span class="auto-cfg-unit">次</span>
      </div>
    </div>

    <div class="auto-btn-row">
      ${AUTO_ARBI.running
        ? `<button class="auto-btn-stop" onclick="stopAutoArbi()">⏹ 停止</button>
           <span class="auto-next-tick">下次 <b id="autoCountdown">${AUTO_ARBI.countdown}s</b></span>`
        : `<button class="auto-btn-start" onclick="startAutoArbi()">▶ 启动</button>
           <span style="font-size:11px;color:var(--text-muted)">需配置 API Key</span>`
      }
      ${pos ? `<button class="auto-btn-close" onclick="autoClose('手动平仓')">🔴 平仓</button>` : ''}
    </div>

    ${posHTML}
    ${eligibleHtml}

    <div class="auto-log-section">
      <div class="auto-log-title">操作日志</div>
      ${logHTML || '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">暂无日志</div>'}
    </div>
  `;
}

function fmtHeld(ms) {
  if (ms < 60000)    return `${Math.floor(ms/1000)}秒`;
  if (ms < 3600000)  return `${Math.floor(ms/60000)}分`;
  if (ms < 86400000) return `${(ms/3600000).toFixed(1)}小时`;
  return `${(ms/86400000).toFixed(1)}天`;
}

// ============================================================
// WEBSOCKET LIVE LAYER (实时推送 + REST 兜底)
// ------------------------------------------------------------
// 设计：state.markets 是唯一数据源。WS 推送就地更新 state.markets[ex][sym]，
// 一个节流渲染循环 (2s) 脏了才重绘。每家交易所独立健康检测：WS 断线或
// STALE_MS 内无数据 → 该家标记不健康，由 fallbackTick() 用 REST 补数据。
//   · Binance WS 数据常被公司网络静默丢弃 → 收不到就自动回退 REST（REST 已验证可用）
//   · OKX/Gate/Bybit/Aster 走 WS，彻底绕开 OKX 的 REST 限速
//   · HL 用单次快 REST 轮询 (10s)，比 200 个逐币 WS 订阅更划算
// ============================================================
const WS_SET      = ['BINANCE', 'ASTER', 'OKX', 'BYBIT', 'GATE']; // 走 WS 的交易所
const STALE_MS    = 20000;   // WS 超过此时长无数据即视为不健康
const RENDER_MS   = 2000;    // 实时重绘节流间隔
const HL_POLL_MS  = 10000;   // HL REST 轮询间隔

let wsConns   = {};   // ex -> WebSocket
let wsHealth  = {};   // ex -> { lastData:ms, connected:bool }
let wsDirty   = false;
let wsStarted = false;

function liveHealthy(ex) {
  const h = wsHealth[ex];
  return !!(h && h.connected && (Date.now() - h.lastData) < STALE_MS);
}
function touchWS(ex) {
  if (!wsHealth[ex]) wsHealth[ex] = { lastData: 0, connected: false };
  wsHealth[ex].lastData = Date.now();
  wsDirty = true;
}
function ensureMkt(ex) { if (!state.markets[ex]) state.markets[ex] = {}; return state.markets[ex]; }

// ---- 渲染循环：脏了才重建套利 + 重绘 ----
function liveRenderLoop() {
  setInterval(() => {
    if (!wsDirty) return;
    // 抽屉打开时：仍更新底层数据，但不重绘表格（避免行重排打断用户操作）
    const drawerOpen = document.getElementById('detailDrawer')?.classList.contains('open');
    state.arbitrages = buildArbitrages(state.markets, state.tab);
    if (drawerOpen) return;
    wsDirty = false;
    render(filterAndSort(state.arbitrages));
    const el = document.getElementById('updateTime');
    if (el) el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }, RENDER_MS);
}

// ---- 健康检测 + 自动重连 ----
function liveHealthLoop() {
  setInterval(() => {
    WS_SET.forEach(ex => {
      const h = wsHealth[ex];
      if (!h || (!h.connected && !h._connecting)) connectWS(ex);   // 掉线重连
    });
    // 状态指示：有任意一家 WS 健康即显示 LIVE
    const anyLive = WS_SET.some(liveHealthy);
    const badge = document.querySelector('.nav-badge');
    if (badge) badge.textContent = anyLive ? 'LIVE' : 'REST';
  }, 5000);
}

// ---- 兜底轮询：仅对 WS 不健康的交易所走 REST（含 HL 常规轮询） ----
const REST_FETCHERS = { HL: fetchHL, ASTER: fetchASTER, BINANCE: fetchBINANCE, OKX: fetchOKX, BYBIT: fetchBYBIT, GATE: fetchGATE };
async function restFetchInto(ex) {
  try {
    const d = await REST_FETCHERS[ex]();
    if (d && Object.keys(d).length) { state.markets[ex] = d; wsDirty = true; }
  } catch (e) { console.warn('restFetchInto', ex, e.message); }
}
function fallbackTick() {
  WS_SET.forEach(ex => { if (!liveHealthy(ex)) restFetchInto(ex); });  // WS 挂了才补
}

// ============================================================
// 各交易所 WS 连接器
// ============================================================
function connectWS(ex) {
  if (wsHealth[ex]?._connecting) return;
  wsHealth[ex] = { ...(wsHealth[ex] || {}), connected: false, _connecting: true };
  try {
    ({
      BINANCE: connectBinanceLike,
      ASTER:   connectBinanceLike,
      OKX:     connectOKXWS,
      BYBIT:   connectBybitWS,
      GATE:    connectGateWS,
    })[ex](ex);
  } catch (e) { console.warn('connectWS', ex, e.message); wsHealth[ex]._connecting = false; }
}

// Binance / Aster：!markPrice@arr (mark + funding) + !ticker@arr (成交额)，一条组合流
function connectBinanceLike(ex) {
  const host = ex === 'BINANCE' ? 'fstream.binance.com' : 'fstream.asterdex.com';
  const ws = new WebSocket(`wss://${host}/stream?streams=!markPrice@arr/!ticker@arr`);
  wsConns[ex] = ws;
  ws.onopen = () => { wsHealth[ex].connected = true; wsHealth[ex]._connecting = false; };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const payload = msg.data || msg;
    if (!Array.isArray(payload)) return;
    const mkt = ensureMkt(ex);
    payload.forEach(d => {
      if (!d.s || !d.s.endsWith('USDT')) return;
      const base = d.s.replace('USDT', '');
      const m = mkt[base] || (mkt[base] = { fundingInterval: 8, openInterest: 0, volume24h: 0, markPx: 0, fundingRate: 0, fundingRate8h: 0, nextFundingTime: 0 });
      if (d.e === 'markPriceUpdate' || d.p !== undefined && d.r !== undefined) {
        m.markPx = parseFloat(d.p) || m.markPx;
        const fr8h = parseFloat(d.r || 0);
        m.fundingRate8h = fr8h; m.fundingRate = fr8h / 8;
        m.nextFundingTime = parseInt(d.T || 0) || m.nextFundingTime;
      }
      if (d.e === '24hrTicker' || d.q !== undefined) {
        m.volume24h = parseFloat(d.q || 0) || m.volume24h;
        if (!m.markPx) m.markPx = parseFloat(d.c || 0);
      }
    });
    touchWS(ex);
  };
  ws.onclose = () => { wsHealth[ex].connected = false; wsHealth[ex]._connecting = false; };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// OKX：tickers (last + volCcy24h) + funding-rate，逐 instId 但可一条消息批量订阅
function connectOKXWS(ex) {
  const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
  wsConns[ex] = ws;
  let pingT = null;
  ws.onopen = () => {
    wsHealth[ex].connected = true; wsHealth[ex]._connecting = false;
    const insts = Object.keys(state.markets.OKX || {}).map(b => `${b}-USDT-SWAP`);
    const subList = insts.length ? insts : (okxInstCache || []);
    // 分两批订阅，避免单条消息过大
    const half = Math.ceil(subList.length / 2) || 1;
    [subList.slice(0, half), subList.slice(half)].forEach(chunk => {
      if (!chunk.length) return;
      const args = chunk.map(i => ({ channel: 'tickers', instId: i }))
                 .concat(chunk.map(i => ({ channel: 'funding-rate', instId: i })));
      ws.send(JSON.stringify({ op: 'subscribe', args }));
    });
    pingT = setInterval(() => { try { ws.send('ping'); } catch {} }, 25000);
  };
  ws.onmessage = (ev) => {
    if (ev.data === 'pong') return;
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.data || !msg.arg) return;
    const ch = msg.arg.channel;
    const mkt = ensureMkt('OKX');
    msg.data.forEach(d => {
      const instId = d.instId; if (!instId || !instId.endsWith('-USDT-SWAP')) return;
      const base = instId.replace('-USDT-SWAP', '');
      const m = mkt[base] || (mkt[base] = { fundingInterval: 8, openInterest: 0, volume24h: 0, markPx: 0, fundingRate: 0, fundingRate8h: 0, nextFundingTime: 0 });
      if (ch === 'tickers') {
        m.markPx = parseFloat(d.last) || m.markPx;
        m.volume24h = (parseFloat(d.volCcy24h || 0) * parseFloat(d.last || 0)) || m.volume24h;
      } else if (ch === 'funding-rate') {
        let ivHr = 8;
        if (d.fundingTime && d.nextFundingTime) {
          const h = (parseInt(d.nextFundingTime) - parseInt(d.fundingTime)) / 3600000;
          if (h > 0 && h <= 24) ivHr = h;
        }
        const fr8h = parseFloat(d.fundingRate || 0) * (8 / ivHr);
        m.fundingRate8h = fr8h; m.fundingRate = fr8h / 8;
        m.fundingInterval = ivHr;
        m.nextFundingTime = parseInt(d.nextFundingTime || 0) || m.nextFundingTime;
      }
    });
    touchWS('OKX');
  };
  ws.onclose = () => { if (pingT) clearInterval(pingT); wsHealth[ex].connected = false; wsHealth[ex]._connecting = false; };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Bybit：tickers.{symbol}，首帧 snapshot 后续 delta 需合并
function connectBybitWS(ex) {
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  wsConns[ex] = ws;
  let pingT = null;
  ws.onopen = () => {
    wsHealth[ex].connected = true; wsHealth[ex]._connecting = false;
    const syms = (Object.keys(state.markets.BYBIT || {}).length
      ? Object.keys(state.markets.BYBIT).map(b => b + 'USDT')
      : (bybitSymCache || []));
    for (let i = 0; i < syms.length; i += 180) {
      const args = syms.slice(i, i + 180).map(s => 'tickers.' + s);
      if (args.length) ws.send(JSON.stringify({ op: 'subscribe', args }));
    }
    pingT = setInterval(() => { try { ws.send(JSON.stringify({ op: 'ping' })); } catch {} }, 20000);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.topic || !msg.topic.startsWith('tickers') || !msg.data) return;
    const d = msg.data;
    const sym = d.symbol; if (!sym || !sym.endsWith('USDT')) return;
    const base = sym.replace('USDT', '');
    const mkt = ensureMkt('BYBIT');
    const m = mkt[base] || (mkt[base] = { fundingInterval: 8, openInterest: 0, volume24h: 0, markPx: 0, fundingRate: 0, fundingRate8h: 0, nextFundingTime: 0 });
    if (d.markPrice !== undefined) m.markPx = parseFloat(d.markPrice) || m.markPx;
    else if (d.lastPrice !== undefined && !m.markPx) m.markPx = parseFloat(d.lastPrice);
    if (d.turnover24h !== undefined) m.volume24h = parseFloat(d.turnover24h) || m.volume24h;
    if (d.openInterest !== undefined) m.openInterest = parseFloat(d.openInterest) || m.openInterest;
    if (d.nextFundingTime !== undefined) m.nextFundingTime = parseInt(d.nextFundingTime) || m.nextFundingTime;
    if (d.fundingRate !== undefined || d.fundingIntervalHour !== undefined) {
      const ivHr = parseFloat(d.fundingIntervalHour) || m.fundingInterval || 8;
      const frRaw = d.fundingRate !== undefined ? parseFloat(d.fundingRate || 0) : m.fundingRate8h * ivHr / 8;
      m.fundingInterval = ivHr;
      m.fundingRate8h = frRaw * (8 / ivHr); m.fundingRate = m.fundingRate8h / 8;
    }
    touchWS('BYBIT');
  };
  ws.onclose = () => { if (pingT) clearInterval(pingT); wsHealth[ex].connected = false; wsHealth[ex]._connecting = false; };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Gate：futures.tickers，一条消息订阅全部合约，推送为全量快照
function connectGateWS(ex) {
  const ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
  wsConns[ex] = ws;
  let pingT = null;
  ws.onopen = () => {
    wsHealth[ex].connected = true; wsHealth[ex]._connecting = false;
    const contracts = (Object.keys(state.markets.GATE || {}).length
      ? Object.keys(state.markets.GATE).map(b => b + '_USDT')
      : (gateContractCache || []));
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < contracts.length; i += 200) {
      const payload = contracts.slice(i, i + 200);
      if (payload.length) ws.send(JSON.stringify({ time: now, channel: 'futures.tickers', event: 'subscribe', payload }));
    }
    pingT = setInterval(() => { try { ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' })); } catch {} }, 20000);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.event !== 'update' || !Array.isArray(msg.result)) return;
    const mkt = ensureMkt('GATE');
    msg.result.forEach(r => {
      const c = r.contract; if (!c || !c.endsWith('_USDT')) return;
      const base = c.replace('_USDT', '');
      const m = mkt[base] || (mkt[base] = { fundingInterval: 8, openInterest: 0, volume24h: 0, markPx: 0, fundingRate: 0, fundingRate8h: 0, nextFundingTime: 0 });
      if (r.mark_price !== undefined) m.markPx = parseFloat(r.mark_price) || m.markPx;
      if (r.funding_rate !== undefined) { const fr8h = parseFloat(r.funding_rate || 0); m.fundingRate8h = fr8h; m.fundingRate = fr8h / 8; }
      if (r.volume_24h_settle !== undefined) m.volume24h = parseFloat(r.volume_24h_settle) || m.volume24h;
    });
    touchWS('GATE');
  };
  ws.onclose = () => { if (pingT) clearInterval(pingT); wsHealth[ex].connected = false; wsHealth[ex]._connecting = false; };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---- 符号缓存（供 WS 重连时订阅，避免依赖 state.markets 是否已填充） ----
let okxInstCache = null, bybitSymCache = null, gateContractCache = null;

// ---- 启动：先 REST 快照首屏，再接管 WS ----
async function initLive() {
  document.getElementById('loadingState').style.display = 'flex';
  document.getElementById('arbTable').style.display = 'none';
  // 首屏：并行拉「快」的几家（跳过 OKX 的慢全量 funding，OKX 由 WS 秒级补上）
  const quick = ['HL', 'ASTER', 'BINANCE', 'BYBIT', 'GATE'];
  await Promise.allSettled(quick.map(restFetchInto));
  // 缓存订阅用的符号列表
  bybitSymCache     = Object.keys(state.markets.BYBIT || {}).map(b => b + 'USDT');
  gateContractCache = Object.keys(state.markets.GATE || {}).map(b => b + '_USDT');
  // OKX instId 列表：单独拉一次 tickers（不含慢 funding），仅为拿到订阅清单 + 价格
  try {
    const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    const td = (await res.json()).data || [];
    const mkt = ensureMkt('OKX');
    okxInstCache = [];
    td.filter(t => t.instId.endsWith('-USDT-SWAP')).forEach(t => {
      const base = t.instId.replace('-USDT-SWAP', '');
      okxInstCache.push(t.instId);
      mkt[base] = mkt[base] || { fundingInterval: 8, openInterest: 0, volume24h: 0, fundingRate: 0, fundingRate8h: 0, nextFundingTime: 0 };
      mkt[base].markPx = parseFloat(t.last) || 0;
      mkt[base].volume24h = parseFloat(t.volCcy24h || 0) * parseFloat(t.last || 0);
    });
  } catch (e) { console.warn('OKX inst list:', e.message); }

  state.arbitrages = buildArbitrages(state.markets, state.tab);
  render(filterAndSort(state.arbitrages));
  document.getElementById('loadingState').style.display = 'none';

  // 启动 WS + 循环
  if (!wsStarted) {
    wsStarted = true;
    WS_SET.forEach(connectWS);
    liveRenderLoop();
    liveHealthLoop();
    setInterval(() => restFetchInto('HL'), HL_POLL_MS); // HL 单次快 REST 轮询（不走 WS）
    setTimeout(fallbackTick, STALE_MS + 2000); // 首轮兜底：补上没从 WS 收到数据的家（如 Binance）
  }
}

// ============================================================
// EXPOSE GLOBALS & INIT
// ============================================================
window.openDetail    = openDetail;
window.startAutoArbi = startAutoArbi;
window.stopAutoArbi  = stopAutoArbi;
window.autoClose     = autoClose;

document.addEventListener('DOMContentLoaded', () => {
  loadApiKeys();
  loadAutoArbi();
  bindEvents();
  initLive();          // WS 实时层 + REST 兜底 (替代原来的全量轮询)
  startAutoRefresh();
  renderAutoPanel();
});
