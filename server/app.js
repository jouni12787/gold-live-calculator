const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const TIMEFRAME_CONFIG = Object.freeze({
  '1h': { windowMs: 1 * 60 * 60 * 1000, limit: 120 },
  '6h': { windowMs: 6 * 60 * 60 * 1000, limit: 150 },
  '24h': { windowMs: 24 * 60 * 60 * 1000, limit: 200 },
  '1y': { windowMs: 365 * 24 * 60 * 60 * 1000, limit: 500 },
  '1y+': { windowMs: Infinity, limit: 500 },
  long: { windowMs: Infinity, limit: 500 },
  max: { windowMs: Infinity, limit: 500 },
  all: { windowMs: Infinity, limit: 500 }
});

let longTermDataPromise = null;
let normalizedLongTermDataPromise = null;

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

async function loadNormalizedLongTermData() {
  if (!normalizedLongTermDataPromise) {
    normalizedLongTermDataPromise = loadLongTermData()
      .then(data => normalizePoints(data))
      .catch(err => {
        normalizedLongTermDataPromise = null;
        throw err;
      });
  }
  return normalizedLongTermDataPromise;
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
  if (!Array.isArray(points) || !points.length) return points || [];
  if (!Number.isFinite(windowMs) || windowMs === Infinity) return points.slice();
  const latestTimestamp = points[points.length - 1]?.timestamp;
  const anchor = Number.isFinite(latestTimestamp) ? latestTimestamp : Date.now();
  const cutoff = anchor - windowMs;
  return points.filter(point => Number(point.timestamp) >= cutoff);
}

app.get('/api/chart-data', async (req, res) => {
  const timeframeRaw = typeof req.query.timeframe === 'string' ? req.query.timeframe : 'all';
  const timeframe = timeframeRaw.trim().toLowerCase() || 'all';

  try {
    const config = TIMEFRAME_CONFIG[timeframe];
    if (!config) {
      return res.status(400).json({ error: 'Unsupported timeframe' });
    }

    const normalized = await loadNormalizedLongTermData();
    const limit = Number.isFinite(config.limit) && config.limit > 0 ? config.limit : 500;
    let windowed = applyTimeWindow(normalized, config.windowMs);
    if (windowed.length < 2) {
      windowed = normalized.slice(-Math.min(limit, normalized.length));
    }
    const sampled = downsample(windowed, limit);

    res.json(sampled);
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
