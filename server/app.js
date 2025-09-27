const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const REAL_TIME_API_ENDPOINT = process.env.REAL_TIME_API_ENDPOINT || '';

let fetchImpl = global.fetch;
if (typeof fetchImpl !== 'function') {
  fetchImpl = async (...args) => {
    const { default: fetch } = await import('node-fetch');
    fetchImpl = fetch;
    return fetch(...args);
  };
}

const LONG_TERM_TIMEFRAMES = new Set(['all', '1y', '1y+', 'long', 'max']);
const REAL_TIME_TIMEFRAMES = Object.freeze({
  '1h': { granularity: '1m', limit: 90, windowMs: 60 * 60 * 1000 },
  '6h': { granularity: '5m', limit: 90, windowMs: 6 * 60 * 60 * 1000 },
  '24h': { granularity: '15m', limit: 96, windowMs: 24 * 60 * 60 * 1000 }
});

let longTermDataPromise = null;

async function loadLongTermData() {
  if (!longTermDataPromise) {
    const filePath = path.join(__dirname, '..', 'data', 'historical_data_cache.json');
    longTermDataPromise = fs.readFile(filePath, 'utf8')
      .then(raw => JSON.parse(raw))
      .catch(err => {
        longTermDataPromise = null;
        throw new Error(`Failed to load historical cache: ${err.message}`);
      });
  }
  const data = await longTermDataPromise;
  return Array.isArray(data) ? data : [];
}

function normalizeTimestamp(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    if (value > 1e14) return Math.round(value);
    if (value > 1e12) return Math.round(value);
    if (value > 1e10) return Math.round(value);
    if (value > 1e9) return Math.round(value * 1000);
    return Math.round(value * 1000);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return normalizeTimestamp(parsed);
    const dateParsed = Date.parse(value);
    return Number.isNaN(dateParsed) ? NaN : dateParsed;
  }
  return NaN;
}

function normalizePrice(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function normalizePoint(point) {
  if (!point) return null;
  if (Array.isArray(point)) {
    const [tsRaw, priceRaw] = point;
    const timestamp = normalizeTimestamp(tsRaw);
    const price = normalizePrice(priceRaw);
    if (Number.isFinite(timestamp) && Number.isFinite(price)) {
      return { timestamp, price_usd: price };
    }
    return null;
  }

  if (typeof point === 'object') {
    const timestamp = normalizeTimestamp(
      point.timestamp ?? point.time ?? point.t ?? point.date ?? point[0]
    );
    const price = normalizePrice(
      point.price_usd ?? point.price ?? point.value ?? point.usd ?? point.p ?? point.close ?? point[1]
    );
    if (Number.isFinite(timestamp) && Number.isFinite(price)) {
      return { timestamp, price_usd: price };
    }
    if (Number.isFinite(timestamp) && Array.isArray(point.value)) {
      const inner = normalizePoint(point.value);
      if (inner) return inner;
    }
  }
  return null;
}

function normalizePoints(points) {
  if (!Array.isArray(points)) return [];
  const normalized = [];
  for (const point of points) {
    const norm = normalizePoint(point);
    if (norm) normalized.push(norm);
  }
  normalized.sort((a, b) => a.timestamp - b.timestamp);
  const deduped = [];
  for (const point of normalized) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.timestamp === point.timestamp) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }
  return deduped;
}

function downsample(points, limit) {
  if (!Array.isArray(points) || points.length <= limit) return points || [];
  const step = Math.ceil(points.length / limit);
  const sampled = [];
  for (let i = 0; i < points.length; i += step) {
    sampled.push(points[i]);
  }
  const last = points[points.length - 1];
  if (last && sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }
  const minPt = points.reduce((min, pt) => (pt.price_usd < min.price_usd ? pt : min), points[0]);
  const maxPt = points.reduce((max, pt) => (pt.price_usd > max.price_usd ? pt : max), points[0]);
  const ensure = pt => {
    if (!pt) return;
    if (!sampled.some(item => item.timestamp === pt.timestamp && item.price_usd === pt.price_usd)) {
      sampled.push(pt);
    }
  };
  ensure(minPt);
  ensure(maxPt);
  sampled.sort((a, b) => a.timestamp - b.timestamp);
  return sampled;
}

function applyTimeWindow(points, windowMs) {
  if (!Array.isArray(points) || !Number.isFinite(windowMs)) return points || [];
  const cutoff = Date.now() - windowMs;
  return points.filter(point => Number(point.timestamp) >= cutoff);
}

async function fetchRealTimeSeries(timeframe) {
  if (!REAL_TIME_API_ENDPOINT) {
    throw new Error('REAL_TIME_API_ENDPOINT is not configured');
  }
  const cfg = REAL_TIME_TIMEFRAMES[timeframe];
  if (!cfg) {
    throw new Error(`Unsupported real-time timeframe: ${timeframe}`);
  }
  const url = new URL(REAL_TIME_API_ENDPOINT);
  url.searchParams.set('timeframe', timeframe);
  if (cfg.granularity) url.searchParams.set('granularity', cfg.granularity);
  if (cfg.limit) url.searchParams.set('limit', String(Math.min(cfg.limit, 99)));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      headers: { 'accept': 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`Real-time API error: ${response.status}`);
    }
    const payload = await response.json();
    const rawPoints = Array.isArray(payload) ? payload : payload.data || payload.result || [];
    const normalized = normalizePoints(rawPoints);
    return normalized.slice(-Math.min(cfg.limit, 99));
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/chart-data', async (req, res) => {
  const timeframeRaw = typeof req.query.timeframe === 'string' ? req.query.timeframe : 'all';
  const timeframe = timeframeRaw.trim().toLowerCase() || 'all';

  try {
    let points;
    if (LONG_TERM_TIMEFRAMES.has(timeframe)) {
      const cached = await loadLongTermData();
      points = downsample(normalizePoints(cached), 500);
    } else if (REAL_TIME_TIMEFRAMES[timeframe]) {
      const cfg = REAL_TIME_TIMEFRAMES[timeframe];
      try {
        points = await fetchRealTimeSeries(timeframe);
      } catch (realTimeErr) {
        console.warn(`Real-time API failed for ${timeframe}, falling back to cached data:`, realTimeErr);
        const cached = await loadLongTermData();
        const normalized = normalizePoints(cached);
        const windowed = applyTimeWindow(normalized, cfg.windowMs);
        const limit = Math.max(1, Math.min(cfg.limit || 99, 99));
        points = downsample(windowed, limit);
      }
    } else {
      return res.status(400).json({ error: 'Unsupported timeframe' });
    }

    res.json(points);
  } catch (err) {
    console.error('Failed to build chart data:', err);
    res.status(502).json({ error: 'Failed to load chart data' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Chart data service listening on port ${PORT}`);
  });
}

module.exports = app;
