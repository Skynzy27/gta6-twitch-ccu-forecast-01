// gta6-twitch-ccu-forecast-01 — log-scale launch-curve forecaster (Node 22, stdlib only).
//
// Idea: a launch day's Twitch curve is mostly decided by WHEN the game unlocks
// relative to UTC midnight, and by how much of its audience was already watching
// in hour 1. Hour 1's print anchors the level; the shape (log viewers at hour h
// minus log viewers at hour 1) is borrowed from past big launches in the case's
// own `comparables`, with three views blended per hour:
//
//   1. a quadratic regression of the log-ratio on log(hour-1 viewers), fitted on
//      comparables whose hour 1 was at least 5,000 (the tiny-hour-1 launches,
//      whose unlock falls late in the day and whose ratios explode 100-2000x,
//      would otherwise drag the fit);
//   2. the median log-ratio of the 12 comparables nearest in log hour-1 size;
//   3. the median log-ratio of the rolling-midnight-unlock comparables
//      (GTA VI unlocks at local midnight, rolling, so this is its own family).
//
//   Weights 0.7 / 0.15 / 0.15, then a light 3-point smooth across hours. The spread
// is honest, not fitted to look confident: for each of the 12 nearest
// comparables we re-predict its curve leaving it out of the pool and keep the
// residual; the 5/25/75/95 quantiles are the empirical quantiles of those
// leave-one-out residuals per hour. A target as big as GTA VI gets the tight
// spread of other big launches, not the wild spread of tiny ones.
//
// Everything the program knows comes from the case file it is given. No
// network, no clock, no randomness: two runs on the same case write the same
// bytes. The target's own history, streams and categories_hourly are deliberately
// unused — they are null in the practice cases, so no use of them could have
// been validated before the final.
//
// Output: /output/<id>.out = {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]},
// exactly 23 rows, hours 2..24, each q finite, > 0, at most 1e9, non-decreasing.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Hours to forecast. */
const HOURS: number[] = [];
for (let h = 2; h <= 24; h++) HOURS.push(h);

/** Blend weights: [quadratic log-size regression, kNN median, rolling-midnight median]. */
const W = [0.7, 0.15, 0.15];
/** kNN neighbourhood size (also the residual pool). */
const K = 12;
/** Comparables below this hour-1 size are left out of the regression fit. */
const FIT_MIN_H1 = 5000;

interface HourlyRow { from: string; viewers: number; channels?: number | null }
interface Comparable {
  name: string;
  day_start: string;
  unlock: string;
  platforms: string;
  hourly: HourlyRow[];
}
interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** x rounded to 2 decimals (half up), matching the house baseline's rounding. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Parse an ISO timestamp to epoch milliseconds. */
const parseTime = (t: string): number => Date.parse(t);

/** The release-day curve of a comparable: viewers for hours 1..24, or null. */
function dayCurve(c: Comparable): number[] | null {
  const start = parseTime(c.day_start);
  if (!Number.isFinite(start)) return null;
  const byHour = new Map<number, number>();
  for (const row of c.hourly ?? []) {
    const t = parseTime(row.from);
    if (!Number.isFinite(t)) continue;
    const dh = (t - start) / 3600000;
    if (dh >= 0 && dh < 24 && Number.isInteger(dh)) byHour.set(dh + 1, row.viewers);
  }
  const curve: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const v = byHour.get(h);
    if (v === undefined || !Number.isFinite(v)) return null;
    curve.push(v);
  }
  return curve;
}

/** Unlock family, from the comparable's own unlock note. */
function groupOf(c: Comparable): string {
  const u = (c.unlock ?? '').toLowerCase();
  if (
    u.includes('early access') &&
    (u.includes('from midnight') || u.includes('began') || u.includes('72 h') ||
      u.includes('premium') || u.includes('deluxe'))
  ) return 'early';
  if (u.includes('simultaneous') || u.includes('single global')) return 'simul';
  if (u.includes('midnight local')) return 'rolling';
  return 'other';
}

interface Member {
  name: string;
  group: string;
  h1: number;
  logH1: number;
  /** log(viewers_h / viewers_1) for h = 2..24, indexed by hour. */
  logRatio: Map<number, number>;
}

function buildPool(cs: Case): Member[] {
  const pool: Member[] = [];
  for (const c of cs.comparables ?? []) {
    // The GTA VI category's own pre-release history is not a launch: skip it.
    const u = (c.unlock ?? '').toLowerCase();
    if (u.includes('not a launch') || (c.name ?? '').includes('before release')) continue;
    const curve = dayCurve(c);
    if (curve === null) continue;
    const h1 = Math.max(1, curve[0]);
    const logRatio = new Map<number, number>();
    for (const h of HOURS) logRatio.set(h, Math.log(Math.max(1, curve[h - 1]) / h1));
    pool.push({ name: c.name ?? '', group: groupOf(c), h1, logH1: Math.log(h1), logRatio });
  }
  pool.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pool;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Solve a small dense linear system by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let cc = col; cc <= n; cc++) M[r][cc] -= f * M[col][cc];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let cc = r + 1; cc < n; cc++) s -= M[r][cc] * x[cc];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Median log-ratio curve for a target of log hour-1 size `logH1`, from a pool.
 * The three views (quadratic size regression, kNN median, rolling median).
 */
function predictMedian(logH1: number, pool: Member[]): Map<number, number> {
  const med = new Map<number, number>();
  const fitPool = pool.filter((m) => m.h1 >= FIT_MIN_H1);
  const use = fitPool.length >= 5 ? fitPool : pool;
  const rolling = pool.filter((m) => m.group === 'rolling');
  const near = [...pool]
    .sort((a, b) => {
      const da = Math.abs(a.logH1 - logH1);
      const db = Math.abs(b.logH1 - logH1);
      return da !== db ? da - db : a.name < b.name ? -1 : 1;
    })
    .slice(0, K);

  for (const h of HOURS) {
    // (1) Quadratic OLS of log-ratio on centred log hour-1 size.
    let e1 = 0;
    const xs = use.map((m) => m.logH1);
    const ys = use.map((m) => m.logRatio.get(h) ?? 0);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const X = xs.map((x) => [1, x - mx, (x - mx) * (x - mx)]);
    const n = 3;
    const A: number[][] = [];
    const v: number[] = [];
    for (let a = 0; a < n; a++) {
      A.push([]);
      for (let b = 0; b < n; b++) A[a].push(X.reduce((s, row, i) => s + row[a] * row[b], 0) + (a === b ? 1e-9 : 0));
      v.push(X.reduce((s, row, i) => s + row[a] * ys[i], 0));
    }
    const beta = solve(A, v);
    if (beta !== null) {
      const d = logH1 - mx;
      e1 = beta[0] + beta[1] * d + beta[2] * d * d;
    } else {
      e1 = ys.reduce((a, b) => a + b, 0) / ys.length;
    }
    // (2) kNN median.
    const e2 = median(near.map((m) => m.logRatio.get(h) ?? 0));
    // (3) Rolling-midnight median.
    const e3 = rolling.length > 0 ? median(rolling.map((m) => m.logRatio.get(h) ?? 0)) : e1;
    med.set(h, W[0] * e1 + W[1] * e2 + W[2] * e3);
  }
  // Light 3-point smooth across hours (endpoints kept).
  const sm = new Map<number, number>();
  for (const h of HOURS) {
    const nb = [h - 1, h, h + 1].filter((k) => med.has(k)).map((k) => med.get(k) as number);
    sm.set(h, nb.reduce((a, b) => a + b, 0) / nb.length);
  }
  return sm;
}

/** Empirical quantile with linear interpolation on a sorted sample. */
function empQuantile(sorted: number[], tau: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const i = tau * (n - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function forecastCase(cs: Case): { hours: Array<{ hour: number; q: number[] }> } {
  if (cs.levels.length !== LEVELS.length || cs.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case asks for levels ${JSON.stringify(cs.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = cs.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const logH1 = Math.log(p1);
  const pool = buildPool(cs);

  let med: Map<number, number>;
  let resid = new Map<number, number[]>();
  if (pool.length >= 5) {
    med = predictMedian(logH1, pool);
    // Leave-one-out residuals of the 12 nearest comparables: the honest spread.
    const near = [...pool]
      .sort((a, b) => {
        const da = Math.abs(a.logH1 - logH1);
        const db = Math.abs(b.logH1 - logH1);
        return da !== db ? da - db : a.name < b.name ? -1 : 1;
      })
      .slice(0, K);
    for (const h of HOURS) resid.set(h, []);
    for (const m of near) {
      const sub = pool.filter((x) => x !== m);
      const mj = predictMedian(m.logH1, sub);
      for (const h of HOURS) {
        resid.get(h)?.push((m.logRatio.get(h) ?? 0) - (mj.get(h) ?? 0));
      }
    }
  } else {
    // Degenerate pool: fall back to the house persistence shape.
    med = new Map<number, number>(HOURS.map((h) => [h, 0]));
    for (const h of HOURS) resid.set(h, [-0.15 * Math.sqrt(h - 1), 0.15 * Math.sqrt(h - 1)]);
  }

  // Median calibration: the median of the per-hour residual medians.
  const q50Offset =
    pool.length >= 5
      ? median(HOURS.map((h) => median(resid.get(h) ?? [0])))
      : 0;

  const hours = cs.forecast.map(({ hour }) => {
    const m = med.get(hour) ?? 0;
    const r = [...(resid.get(hour) ?? [0])].sort((a, b) => a - b);
    const qs = LEVELS.map((tau, j) => {
      // The median level uses the blended median plus a calibration offset:
      // the median of the per-hour residual medians. The blend is a mean of
      // three medians and the comparables' big late-unlock ramps pull it up,
      // so the offset (typically about -0.08 in log units) recentres it.
      const spread = j === 2 ? q50Offset : empQuantile(r, tau);
      return clamp(round2(p1 * Math.exp(m + spread)), 1, 1e9);
    });
    // Enforce non-decreasing (rounding can tie adjacent levels; never invert).
    for (let j = 1; j < qs.length; j++) qs[j] = Math.max(qs[j], qs[j - 1]);
    return { hour, q: qs };
  });
  return { hours };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const cs = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const out = forecastCase(cs);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: out.hours })}\n`);
}
