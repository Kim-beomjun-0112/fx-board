// GET /api/rates → { asOf, source, rates: { USD: 원/1단위, ... } }
// 1순위: 한국수출입은행(영업일 고시), 빠진 통화·실패 시: 키 없는 공개 API(open.er-api.com)로 보충.
// 결과는 엣지 캐시에 1시간 보관해 업스트림 호출을 최소화한다.
const CODES = ["USD","JPY","EUR","CNY","GBP","HKD","TWD","VND","THB","PHP","SGD","MYR","IDR","AUD","NZD","CAD","CHF","SEK","NOK","DKK","AED","SAR","INR","MXN","BRL","TRY","MNT","KZT"];
const TTL = 3600;

const kstDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3 - offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};

async function fromExim(key) {
  for (let i = 0; i < 6; i++) {
    const day = kstDate(i);
    const url = `https://www.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${encodeURIComponent(key)}&searchdate=${day.replace(/-/g, "")}&data=AP01`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 fx-board" }, cf: { cacheTtl: 600 } });
    if (!res.ok) continue;
    let arr;
    try { arr = await res.json(); } catch { continue; }
    if (!Array.isArray(arr) || !arr.length || arr[0].result !== 1) continue;
    const rates = {};
    for (const r of arr) {
      const m = /^([A-Z]{3})(?:\((\d+)\))?$/.exec(String(r.cur_unit || "").trim());
      if (!m) continue;
      const v = parseFloat(String(r.deal_bas_r).replace(/,/g, ""));
      if (v > 0) rates[m[1]] = v / (m[2] ? +m[2] : 1);
    }
    if (Object.keys(rates).length) return { day, rates };
  }
  return null;
}

async function fromOpen() {
  const res = await fetch("https://open.er-api.com/v6/latest/KRW");
  if (!res.ok) throw new Error("open api " + res.status);
  const j = await res.json();
  if (j.result !== "success") throw new Error("open api bad");
  const rates = {};
  for (const c of CODES) if (j.rates[c] > 0) rates[c] = 1 / j.rates[c];
  return { day: new Date(j.time_last_update_unix * 1000 + 9 * 3600e3).toISOString().slice(0, 10), rates };
}

async function build(env) {
  let ex = null, op = null, errors = [];
  if (env.EXIM_KEY) { try { ex = await fromExim(env.EXIM_KEY); } catch (e) { errors.push("exim:" + e.message); } }
  try { op = await fromOpen(); } catch (e) { errors.push("open:" + e.message); }
  if (!ex && !op) throw new Error(errors.join(",") || "no source");
  const rates = {}, sources = {};
  for (const c of CODES) {
    if (ex && ex.rates[c]) { rates[c] = ex.rates[c]; sources[c] = "exim"; }
    else if (op && op.rates[c]) { rates[c] = op.rates[c]; sources[c] = "open"; }
  }
  return {
    asOf: (ex || op).day,
    source: ex ? (op ? "한국수출입은행 + 공개 환율 API" : "한국수출입은행") : "공개 환율 API",
    sources, rates, fetchedAt: new Date().toISOString(),
  };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/rates", request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  try {
    const body = await build(env);
    const resp = new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${TTL}` },
    });
    waitUntil?.(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
