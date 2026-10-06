import { existsSync, readFileSync, writeFileSync } from "node:fs";
//#region src/lab/backtest.ts
const W = 52;
function returns(px) {
	const r = [0];
	for (let i = 1; i < px.length; i++) r.push(px[i] / px[i - 1] - 1);
	return r;
}
function stdev(xs) {
	if (xs.length < 2) return 0;
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const norm = (w) => {
	const s = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0);
	const out = {};
	if (s <= 0) return out;
	for (const [k, v] of Object.entries(w)) if (v > 0) out[k] = v / s;
	return out;
};
/** Target weights decided with information up to and including week t. */
function target(p, t, px, rets) {
	const safe = p.safe === "CASH" ? {} : { [p.safe]: 1 };
	switch (p.strategy) {
		case "hold": return { [p.asset]: 1 };
		case "static": return norm(p.weights);
		case "trend": {
			const s = px[p.asset];
			if (t + 1 < p.smaWeeks) return { [p.asset]: 1 };
			let sum = 0;
			for (let k = t - p.smaWeeks + 1; k <= t; k++) sum += s[k];
			return s[t] >= sum / p.smaWeeks ? { [p.asset]: 1 } : safe;
		}
		case "dualmom": {
			if (t < p.lookbackWeeks) return { [p.universe[0]]: 1 };
			let best = "";
			let bestR = -Infinity;
			for (const a of p.universe) {
				const r = px[a][t] / px[a][t - p.lookbackWeeks] - 1;
				if (r > bestR) [best, bestR] = [a, r];
			}
			return bestR > 0 ? { [best]: 1 } : safe;
		}
		case "invvol": {
			const lb = Math.min(p.lookbackWeeks, t);
			if (lb < 8) return norm(Object.fromEntries(p.universe.map((a) => [a, 1])));
			const w = {};
			for (const a of p.universe) {
				const v = stdev(rets[a].slice(t - lb + 1, t + 1));
				w[a] = v > 0 ? 1 / v : 0;
			}
			return norm(w);
		}
		case "voltarget": {
			const lb = Math.min(p.lookbackWeeks, t);
			if (lb < 8) return { [p.asset]: 1 };
			const v = stdev(rets[p.asset].slice(t - lb + 1, t + 1)) * Math.sqrt(W);
			const x = v > 0 ? Math.min(1, p.targetVolPct / 100 / v) : 1;
			return x >= 1 ? { [p.asset]: 1 } : {
				[p.asset]: x,
				...p.safe === "CASH" ? {} : { [p.safe]: 1 - x }
			};
		}
	}
}
function metrics(eq, benchRets, turnover = 0) {
	const r = returns(eq).slice(1);
	const years = r.length / W;
	const cagr = (eq[eq.length - 1] / eq[0]) ** (1 / years) - 1;
	const vol = stdev(r) * Math.sqrt(W);
	const mean = r.reduce((a, b) => a + b, 0) / r.length * W;
	const down = stdev(r.map((x) => Math.min(0, x))) * Math.sqrt(W);
	let peak = eq[0];
	let maxDD = 0;
	for (const v of eq) {
		peak = Math.max(peak, v);
		maxDD = Math.min(maxDD, v / peak - 1);
	}
	let beta = 1;
	if (benchRets) {
		const b = benchRets.slice(1, r.length + 1);
		const mr = r.reduce((a, c) => a + c, 0) / r.length;
		const mb = b.reduce((a, c) => a + c, 0) / b.length;
		let cov = 0;
		let vb = 0;
		for (let i = 0; i < r.length; i++) {
			cov += (r[i] - mr) * (b[i] - mb);
			vb += (b[i] - mb) ** 2;
		}
		beta = vb > 0 ? cov / vb : 0;
	}
	return {
		cagr,
		vol,
		sharpe: vol > 0 ? mean / vol : 0,
		sortino: down > 0 ? mean / down : 0,
		maxDD,
		calmar: maxDD < 0 ? cagr / -maxDD : 0,
		worstWeek: Math.min(...r),
		hitRate: r.filter((x) => x > 0).length / r.length,
		turnover: turnover / years,
		beta,
		final: eq[eq.length - 1]
	};
}
const STRESS = [
	{
		name: "Q4 2018 sell-off",
		from: "2018-09-17",
		to: "2018-12-24"
	},
	{
		name: "COVID crash",
		from: "2020-02-17",
		to: "2020-03-23"
	},
	{
		name: "2022 rate shock",
		from: "2022-01-03",
		to: "2022-10-10"
	},
	{
		name: "2023–24 rally",
		from: "2023-01-02",
		to: "2024-12-30"
	}
];
function backtest(data, p, initial = 1e6) {
	const px = data.series;
	const rets = {};
	for (const [k, v] of Object.entries(px)) rets[k] = returns(v);
	const n = data.dates.length;
	const s = Math.max(0, Math.min(p.startIndex, n - 60));
	const dates = data.dates.slice(s);
	const equity = [initial];
	const bench = [initial];
	const ws = [];
	let w = {};
	let turnover = 0;
	const cost = p.costBps / 1e4;
	for (let t = s; t < n - 1; t++) {
		const rebalance = (t - s) % Math.max(1, p.rebalanceWeeks) === 0 || p.strategy === "trend" || p.strategy === "voltarget";
		if (t === s || rebalance) {
			const next = target(p, t, px, rets);
			const keys = /* @__PURE__ */ new Set([...Object.keys(w), ...Object.keys(next)]);
			let traded = 0;
			for (const k of keys) traded += Math.abs((next[k] ?? 0) - (w[k] ?? 0));
			if (t > s) turnover += traded / 2;
			equity[equity.length - 1] = equity[equity.length - 1] * (1 - traded * cost);
			w = next;
		}
		ws.push(w);
		let r = 0;
		for (const [k, x] of Object.entries(w)) r += x * rets[k][t + 1];
		equity.push(equity[equity.length - 1] * (1 + r));
		bench.push(bench[bench.length - 1] * (1 + rets.SPY[t + 1]));
		const tot = Object.entries(w).reduce((a, [k, x]) => a + x * (1 + rets[k][t + 1]), 0) + (1 - Object.values(w).reduce((a, b) => a + b, 0));
		if (tot > 0) w = Object.fromEntries(Object.entries(w).map(([k, x]) => [k, x * (1 + rets[k][t + 1]) / tot]));
	}
	let peak = equity[0];
	const drawdown = equity.map((v) => (peak = Math.max(peak, v), v / peak - 1));
	const benchRets = returns(bench);
	const stress = STRESS.map((x) => {
		const a = dates.findIndex((d) => d >= x.from);
		let b = dates.findIndex((d) => d >= x.to);
		if (b < 0) b = dates.length - 1;
		if (a < 0 || b <= a) return {
			name: x.name,
			strat: NaN,
			bench: NaN
		};
		return {
			name: x.name,
			strat: equity[b] / equity[a] - 1,
			bench: bench[b] / bench[a] - 1
		};
	});
	return {
		dates,
		equity,
		bench,
		drawdown,
		weights: ws,
		metrics: metrics(equity, benchRets, turnover),
		benchMetrics: metrics(bench, benchRets),
		stress
	};
}
[
	.01,
	.05,
	.1,
	.2,
	.5
].map((eta) => ({ eta })), [
	.5,
	.8,
	.9,
	.95,
	1
].map((eps) => ({ eps })), [
	3,
	5,
	10
].flatMap((window) => [
	5,
	10,
	20
].map((eps) => ({
	window,
	eps
})));
/** Small, fast, seedable PRNG (mulberry32) so every Monte Carlo run is reproducible. */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = a + 1831565813 >>> 0;
		let t = a;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
//#endregion
//#region src/brain/engine.ts
const SPLIT_DATE = "2021-05-10";
const WARMUP = 52;
const FOLDS = 4;
const TIE = .05;
const K_ELO = 16;
const GUARD_DD = -.35;
const GUARD_DRAG = .015;
const HOF_KEEP = 8;
const HYPOTHESES = [
	{
		id: "trend",
		name: "H1 · Trend filter",
		claim: "A moving-average filter on an equity index sidesteps the worst bear markets without giving up most of the return."
	},
	{
		id: "dualmom",
		name: "H2 · Dual momentum",
		claim: "Rotating into the strongest asset, and to a defensive asset when nothing is rising, beats a fixed mix."
	},
	{
		id: "invvol",
		name: "H3 · Inverse volatility",
		claim: "Sizing sleeves by 1/volatility earns a better risk-adjusted return than equal weights."
	},
	{
		id: "voltarget",
		name: "H4 · Volatility target",
		claim: "Cutting exposure when realised volatility spikes improves an equity index's Sharpe ratio."
	},
	{
		id: "static",
		name: "H5 · Strategic mix",
		claim: "A diversified fixed mix, rebalanced on a schedule, is hard to beat after costs."
	}
];
const EQUITY = [
	"SPY",
	"QQQ",
	"IWM",
	"EFA"
];
const DEFENSIVE = [
	"AGG",
	"TLT",
	"GLD",
	"CASH"
];
const ALL = [
	"SPY",
	"QQQ",
	"IWM",
	"EFA",
	"AGG",
	"TLT",
	"GLD",
	"VNQ"
];
function splitIndex(data) {
	const i = data.dates.findIndex((d) => d >= SPLIT_DATE);
	return i < 0 ? data.dates.length - 1 : i;
}
/** The only data selection ever sees: everything up to and including the split week. */
function selectionData(data) {
	const end = splitIndex(data) + 1;
	return {
		source: data.source,
		asOf: data.dates[end - 1],
		dates: data.dates.slice(0, end),
		series: Object.fromEntries(Object.entries(data.series).map(([k, v]) => [k, v.slice(0, end)]))
	};
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
function sd(xs) {
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}
function moments(xs) {
	const m = mean(xs);
	const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1e-12;
	return {
		skew: xs.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / xs.length,
		kurt: xs.reduce((a, b) => a + ((b - m) / s) ** 4, 0) / xs.length
	};
}
/** Standard normal CDF (Zelen & Severo 26.2.17, |error| < 7.5e-8). */
function phi(x) {
	const t = 1 / (1 + .2316419 * Math.abs(x));
	const p = .3989422804014327 * Math.exp(-x * x / 2) * t * (.31938153 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
	return x >= 0 ? 1 - p : p;
}
/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
function phiInv(p) {
	const a = [
		-39.69683028665376,
		220.9460984245205,
		-275.9285104469687,
		138.357751867269,
		-30.66479806614716,
		2.506628277459239
	];
	const b = [
		-54.47609879822406,
		161.5858368580409,
		-155.6989798598866,
		66.80131188771972,
		-13.28068155288572
	];
	const c = [
		-.007784894002430293,
		-.3223964580411365,
		-2.400758277161838,
		-2.549732539343734,
		4.374664141464968,
		2.938163982698783
	];
	const d = [
		.007784695709041462,
		.3224671290700398,
		2.445134137142996,
		3.754408661907416
	];
	const lo = .02425;
	if (p <= 0) return -Infinity;
	if (p >= 1) return Infinity;
	if (p < lo) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	}
	if (p > .97575) return -phiInv(1 - p);
	const q = p - .5;
	const r = q * q;
	return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/**
* Deflated Sharpe Ratio: probability that the true Sharpe is above what the best of `trials`
* unskilled strategies would show by luck. All Sharpe ratios here are per-period (weekly).
*/
function deflatedSharpe(sr, n, skew, kurt, trials, srVar) {
	const g = .5772156649;
	const N = Math.max(2, trials);
	const sr0 = Math.sqrt(Math.max(0, srVar)) * (.4227843351 * phiInv(1 - 1 / N) + g * phiInv(1 - 1 / (N * Math.E)));
	const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr));
	return phi((sr - sr0) * Math.sqrt(Math.max(1, n - 1)) / den);
}
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function gauss(rand) {
	let u = 0;
	while (u === 0) u = rand();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
const pick = (xs, rand) => xs[Math.floor(rand() * xs.length)];
function seedGenome(f) {
	const base = {
		strategy: f,
		asset: "SPY",
		weights: {
			SPY: 60,
			AGG: 40
		},
		universe: ["SPY", "EFA"],
		safe: "AGG",
		smaWeeks: 40,
		lookbackWeeks: 52,
		rebalanceWeeks: 4,
		targetVolPct: 12
	};
	if (f === "invvol") base.universe = [
		"SPY",
		"AGG",
		"GLD"
	];
	return base;
}
function randomGenome(f, rand) {
	const g = seedGenome(f);
	g.asset = pick(EQUITY, rand);
	g.safe = pick(DEFENSIVE, rand);
	g.smaWeeks = clampInt(10 + rand() * 50, 8, 60);
	g.lookbackWeeks = clampInt(8 + rand() * 70, 8, 78);
	g.rebalanceWeeks = clampInt(1 + rand() * 12, 1, 13);
	g.targetVolPct = clamp(Math.round((6 + rand() * 14) * 2) / 2, 5, 20);
	const pool = [...ALL].sort(() => rand() - .5);
	g.universe = pool.slice(0, 2 + Math.floor(rand() * 3));
	if (f === "dualmom") g.universe = [...EQUITY].sort(() => rand() - .5).slice(0, 2 + Math.floor(rand() * 2));
	if (f === "static") g.weights = Object.fromEntries(pool.slice(0, 3 + Math.floor(rand() * 3)).map((a) => [a, 10 + Math.round(rand() * 50)]));
	return normalise(g);
}
function normalise(g) {
	const w = Object.entries(g.weights).filter(([, v]) => v > 0);
	const s = w.reduce((a, [, v]) => a + v, 0) || 1;
	g.weights = Object.fromEntries(w.map(([k, v]) => [k, Math.round(v / s * 100)]));
	g.universe = [...new Set(g.universe)].filter((a) => ALL.includes(a));
	if (g.universe.length < 2) g.universe = ["SPY", "AGG"];
	if (g.strategy === "dualmom") g.universe = g.universe.filter((a) => a !== g.safe);
	if (g.strategy === "dualmom" && g.universe.length < 2) g.universe = ["SPY", "EFA"];
	return g;
}
function mutate(parent, f, rand) {
	const g = JSON.parse(JSON.stringify(parent));
	const s = f.step;
	let fix = null;
	g.smaWeeks = clampInt(g.smaWeeks + gauss(rand) * 6 * s + f.bias.sma, 8, 60);
	g.lookbackWeeks = clampInt(g.lookbackWeeks + gauss(rand) * 8 * s, 8, 78);
	g.rebalanceWeeks = clampInt(g.rebalanceWeeks + gauss(rand) * 1.5 * s + f.bias.rebalance, 1, 13);
	g.targetVolPct = clamp(Math.round((g.targetVolPct + gauss(rand) * 1.5 * s + f.bias.vol) * 2) / 2, 5, 20);
	if (rand() < .15 * s) g.asset = pick(EQUITY, rand);
	if (rand() < .15 * s || f.bias.safe > 0) g.safe = pick(f.bias.safe > 0 ? [
		"AGG",
		"TLT",
		"GLD"
	] : DEFENSIVE, rand);
	if (rand() < .3) {
		const a = pick(g.strategy === "dualmom" ? EQUITY : ALL, rand);
		g.universe = g.universe.includes(a) && g.universe.length > 2 ? g.universe.filter((x) => x !== a) : [...g.universe, a].slice(0, 5);
	}
	if (g.strategy === "static") {
		const keys = Object.keys(g.weights);
		const k = rand() < .2 ? pick(ALL, rand) : pick(keys, rand);
		g.weights[k] = Math.max(0, (g.weights[k] ?? 0) + gauss(rand) * 10 * s);
		if (f.bias.safe > 0) g.weights.AGG = (g.weights.AGG ?? 0) + 5;
	}
	if (f.bias.rebalance > 0) fix = `slower rebalancing (+${f.bias.rebalance.toFixed(1)} wk) after turnover rejections`;
	else if (f.bias.vol < 0 || f.bias.safe > 0) fix = "more defensive settings after drawdown rejections";
	else if (f.bias.sma > 0) fix = "longer signal windows after whipsaw losses";
	f.bias = {
		rebalance: f.bias.rebalance * .6,
		sma: f.bias.sma * .6,
		vol: f.bias.vol * .6,
		safe: Math.max(0, f.bias.safe - 1)
	};
	if (Math.abs(f.bias.rebalance) < .2) f.bias.rebalance = 0;
	if (Math.abs(f.bias.sma) < .5) f.bias.sma = 0;
	if (Math.abs(f.bias.vol) < .2) f.bias.vol = 0;
	return {
		g: normalise(g),
		fix
	};
}
function describe(g) {
	const w = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(" / ");
	switch (g.strategy) {
		case "trend": return `Trend: ${g.asset} above its ${g.smaWeeks}-wk average, else ${g.safe}`;
		case "dualmom": return `Dual momentum: best of ${g.universe.join(", ")} over ${g.lookbackWeeks} wk, else ${g.safe}, every ${g.rebalanceWeeks} wk`;
		case "invvol": return `Inverse vol: ${g.universe.join(", ")} on ${g.lookbackWeeks}-wk vol, every ${g.rebalanceWeeks} wk`;
		case "voltarget": return `Vol target: ${g.asset} at ${g.targetVolPct}% vol (${g.lookbackWeeks}-wk), rest in ${g.safe}`;
		case "static": return `Mix: ${w(g.weights)}, rebalanced every ${g.rebalanceWeeks} wk`;
		default: return g.strategy;
	}
}
const toParams = (g) => ({
	...g,
	costBps: 10,
	startIndex: 0
});
function weekly(eq) {
	const r = [];
	for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1);
	return r;
}
/** Evaluate on the selection window. `sel` must come from selectionData(). */
function evaluate(sel, g, gen, id, srStats, trials) {
	const res = backtest(sel, toParams(g));
	const r = weekly(res.equity).slice(WARMUP);
	const len = Math.floor(r.length / FOLDS);
	const folds = Array.from({ length: FOLDS }, (_, k) => {
		const x = r.slice(k * len, k === 3 ? r.length : (k + 1) * len);
		const v = sd(x);
		return v > 0 ? mean(x) / v * Math.sqrt(52) : 0;
	});
	const v = sd(r);
	const srWeekly = v > 0 ? mean(r) / v : 0;
	const { skew, kurt } = moments(r);
	const m = res.metrics;
	const drag = 2 * m.turnover * (10 / 1e4);
	const c = {
		id,
		family: g.strategy,
		genome: g,
		label: describe(g),
		born: gen,
		elo: 1500,
		score: 0,
		rubric: {
			riskReturn: 0,
			consistency: 0,
			drawdown: 0,
			costs: 0,
			robustness: 0
		},
		is: {
			sharpe: m.sharpe,
			cagr: m.cagr,
			maxDD: m.maxDD,
			turnover: m.turnover,
			drag,
			dsr: 0,
			folds,
			srWeekly,
			skew,
			kurt,
			n: r.length
		}
	};
	rescore(c, srStats, trials);
	return c;
}
/** Recompute the rubric. Robustness depends on how many trials have been run, so scores are refreshed every run. */
function rescore(c, srStats, trials) {
	const srVar = srStats.n > 1 ? srStats.m2 / (srStats.n - 1) : 0;
	c.is.dsr = deflatedSharpe(c.is.srWeekly, c.is.n, c.is.skew, c.is.kurt, trials, srVar);
	c.rubric = {
		riskReturn: 30 * clamp(c.is.sharpe / 1.2, 0, 1),
		consistency: 20 * (c.is.folds.filter((x) => x > 0).length / c.is.folds.length),
		drawdown: 20 * clamp(1 - (-c.is.maxDD - .1) / .25, 0, 1),
		costs: 10 * clamp(1 - c.is.drag / .01, 0, 1),
		robustness: 20 * c.is.dsr
	};
	c.score = Math.round(Object.values(c.rubric).reduce((a, b) => a + b, 0) * 10) / 10;
}
/** Out-of-sample report for display only. Never feeds back into selection. */
function holdout(full, g) {
	const s = splitIndex(full);
	const res = backtest(full, toParams(g));
	const a = metrics(res.equity.slice(s));
	const b = metrics(res.bench.slice(s));
	return {
		cagr: a.cagr,
		sharpe: a.sharpe,
		maxDD: a.maxDD,
		spyCagr: b.cagr,
		spySharpe: b.sharpe,
		spyMaxDD: b.maxDD
	};
}
/** Fold-by-fold Elo match. Returns the challenger's wins and losses. */
function match(champ, ch) {
	let wins = 0;
	let losses = 0;
	for (let k = 0; k < FOLDS; k++) {
		const d = ch.is.folds[k] - champ.is.folds[k];
		const s = d > TIE ? 1 : d < -.05 ? 0 : .5;
		if (s === 1) wins++;
		if (s === 0) losses++;
		const e = 1 / (1 + 10 ** ((champ.elo - ch.elo) / 400));
		ch.elo += K_ELO * (s - e);
		champ.elo -= K_ELO * (s - e);
	}
	ch.elo = Math.round(ch.elo);
	champ.elo = Math.round(champ.elo);
	return {
		wins,
		losses
	};
}
const FAMILIES = HYPOTHESES.map((h) => h.id);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
function initState(full, now) {
	const sel = selectionData(full);
	const s = splitIndex(full);
	const srStats = {
		n: 0,
		mean: 0,
		m2: 0
	};
	const champion = evaluate(sel, seedGenome("static"), 0, "g0-seed", srStats, 1);
	champion.holdout = holdout(full, champion.genome);
	const families = Object.fromEntries(FAMILIES.map((f) => [f, {
		trials: 0,
		wins: 0,
		best: null,
		step: 1,
		recent: [],
		bias: {
			rebalance: 0,
			sma: 0,
			vol: 0,
			safe: 0
		}
	}]));
	return {
		version: 1,
		split: {
			selection: [full.dates[0], full.dates[s]],
			holdout: [full.dates[s], full.dates[full.dates.length - 1]]
		},
		createdAt: now,
		lastRun: now,
		runs: 0,
		generation: 0,
		trials: 0,
		srStats,
		champion,
		families,
		hallOfFame: [champion],
		log: [{
			t: now,
			gen: 0,
			kind: "run",
			text: `Seeded with a 60/40 mix. Selection window ${full.dates[0]} → ${full.dates[s]}; holdout locked from ${full.dates[s]}.`
		}]
	};
}
function ucb(state, f) {
	const fs = state.families[f];
	if (fs.trials === 0) return Infinity;
	const total = FAMILIES.reduce((a, x) => a + state.families[x].trials, 0);
	return fs.wins / fs.trials + Math.sqrt(2 * Math.log(Math.max(2, total)) / fs.trials);
}
/** Run `generations` generations of `children` each. Deterministic for a given state. */
function evolve(state, full, generations, now, children = 6) {
	const sel = selectionData(full);
	const s = JSON.parse(JSON.stringify(state));
	const log = (kind, text) => s.log.push({
		t: now,
		gen: s.generation,
		kind,
		text
	});
	s.runs += 1;
	log("run", `Run ${s.runs} started: ${generations} generations × ${children} children.`);
	const startChampion = s.champion.id;
	for (let gi = 0; gi < generations; gi++) {
		s.generation += 1;
		const rand = rng(2654435761 ^ s.generation * 2654435761);
		const fam = [...FAMILIES].sort((a, b) => ucb(s, b) - ucb(s, a))[0];
		const fs = s.families[fam];
		const parent = fs.best?.genome ?? seedGenome(fam);
		let improved = false;
		let lastFix = null;
		for (let c = 0; c < children; c++) {
			const { g, fix } = !fs.best || rand() < .12 ? {
				g: randomGenome(fam, rand),
				fix: null
			} : mutate(parent, fs, rand);
			if (fix) lastFix = fix;
			s.trials += 1;
			const ch = evaluate(sel, g, s.generation, `g${s.generation}-${c}`, s.srStats, s.trials);
			s.srStats.n += 1;
			const d = ch.is.srWeekly - s.srStats.mean;
			s.srStats.mean += d / s.srStats.n;
			s.srStats.m2 += d * (ch.is.srWeekly - s.srStats.mean);
			fs.trials += 1;
			if (!fs.best || ch.score > fs.best.score) {
				fs.best = ch;
				improved = true;
			}
			const guardDD = ch.is.maxDD < GUARD_DD;
			const guardDrag = ch.is.drag > GUARD_DRAG;
			rescore(s.champion, s.srStats, s.trials);
			const m = match(s.champion, ch);
			if (!guardDD && !guardDrag && m.wins > m.losses && ch.score > s.champion.score) {
				ch.holdout = holdout(full, ch.genome);
				log("promote", `${ch.label} → champion. Score ${ch.score.toFixed(1)} vs ${s.champion.score.toFixed(1)}, won ${m.wins}/${FOLDS} folds, Elo ${ch.elo}. Holdout Sharpe ${ch.holdout.sharpe.toFixed(2)} vs SPY ${ch.holdout.spySharpe.toFixed(2)}.`);
				s.champion = ch;
				fs.wins += 1;
			} else if (guardDrag) {
				fs.bias.rebalance = 2;
				fs.bias.sma = 6;
				log("reject", `${ch.label}: cost drag ${pct(ch.is.drag)}/yr breaks the ${pct(GUARD_DRAG)} guard.`);
			} else if (guardDD) {
				fs.bias.vol = -2;
				fs.bias.safe = 2;
				log("reject", `${ch.label}: drawdown ${pct(ch.is.maxDD)} breaks the ${pct(GUARD_DD)} guard.`);
			} else if (c === children - 1 || rand() < .15) log("reject", `${ch.label}: score ${ch.score.toFixed(1)} vs champion ${s.champion.score.toFixed(1)}, ${m.wins}–${m.losses} on folds.`);
			s.hallOfFame = [...s.hallOfFame.filter((x) => x.id !== ch.id), ch].sort((a, b) => b.score - a.score).filter((x, i, arr) => arr.findIndex((y) => y.label === x.label) === i).filter((x, i, arr) => arr.slice(0, i).filter((y) => y.family === x.family).length < 2).slice(0, HOF_KEEP);
		}
		if (lastFix) log("fix", `${HYPOTHESES.find((h) => h.id === fam).name}: applied ${lastFix}.`);
		fs.recent = [...fs.recent, improved ? 1 : 0].slice(-20);
		const rate = fs.recent.reduce((a, b) => a + b, 0) / fs.recent.length;
		fs.step = clamp(fs.step * (rate > .2 ? 1.2 : .85), .3, 3);
		if (improved) log("explore", `${HYPOTHESES.find((h) => h.id === fam).name}: new family best ${fs.best.label} (score ${fs.best.score.toFixed(1)}).`);
	}
	rescore(s.champion, s.srStats, s.trials);
	for (const c of s.hallOfFame) {
		rescore(c, s.srStats, s.trials);
		if (!c.holdout) c.holdout = holdout(full, c.genome);
	}
	for (const f of FAMILIES) if (s.families[f].best) rescore(s.families[f].best, s.srStats, s.trials);
	if (s.champion.id === startChampion) log("record", `No promotion this run. Champion holds at score ${s.champion.score.toFixed(1)} after ${s.trials.toLocaleString("en-US")} trials (DSR ${pct(s.champion.is.dsr)}).`);
	s.lastRun = now;
	s.log = s.log.slice(-240);
	return s;
}
//#endregion
//#region scripts/brain-run.ts
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const statePath = arg("state", "brain/state.json");
const dataPath = arg("data", "brain/weekly.json");
const gens = Math.max(1, Math.min(200, Number(arg("generations", "24"))));
const now = arg("now", (/* @__PURE__ */ new Date()).toISOString());
const data = JSON.parse(readFileSync(dataPath, "utf8"));
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : initState(data, now);
const t0 = Date.now();
state = evolve(state, data, gens, now);
writeFileSync(statePath, JSON.stringify(state));
const c = state.champion;
console.log(`gen ${state.generation} · ${state.trials} trials · champion "${c.label}" score ${c.score} elo ${c.elo} · holdout Sharpe ${c.holdout?.sharpe.toFixed(2)} vs SPY ${c.holdout?.spySharpe.toFixed(2)} · ${Date.now() - t0} ms`);
//#endregion
export {};
