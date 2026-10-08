"use strict";

/**
 * Which tokens already have a perpetual futures market somewhere.
 *
 * This answers one question the rest of the collector cannot: has some other
 * venue already judged this token liquid and established enough to list a
 * perp on? That is a fact about the token that no amount of pool data
 * reveals, and it turns out to be a sharper filter than market cap.
 *
 * Measured on a live board: nine tokens sat under the $1M-plus-cap screen and
 * were still obviously not emerging - CRV, PENDLE, FET, SAND, AERO, SPX,
 * BRETT, GMX, ZRO. Every one of them already had a Hyperliquid perp. Cap did
 * not catch them; this does.
 *
 * Three venues answer without a key from here:
 *
 *   Hyperliquid   POST /info {"type":"meta"}        234 markets
 *   Binance USD-M GET  /fapi/v1/exchangeInfo        920 markets
 *   Aster         GET  /fapi/v1/exchangeInfo        617 markets
 *
 * OKX and Bybit refuse outright from this network, so they are declared and
 * reported as unreachable rather than quietly missing. A venue that fails
 * leaves its own entry empty and does not take the others down with it -
 * a partial answer still rules out plenty of tokens.
 *
 * Symbols only. Perp venues trade tickers, not contract addresses, so the
 * match is by symbol and is therefore approximate: a memecoin that happens to
 * share a ticker with a listed asset will look listed. That is stated in the
 * output rather than hidden, and the consumer decides how much to trust it.
 */

const { fetchJson } = require("./fetcher");

const VENUES = [
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    reach: async () => {
      const data = await fetchJson("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
        timeoutMs: 20000,
      });
      return (data && data.universe ? data.universe : [])
        .map((row) => String(row && row.name || "").toUpperCase())
        .filter(Boolean);
    },
  },
  {
    id: "binance",
    label: "Binance USD-M",
    reach: async () => {
      const data = await fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo", {
        timeoutMs: 20000,
      });
      return (data && data.symbols ? data.symbols : [])
        .filter((s) => s && s.contractType === "PERPETUAL" && s.status === "TRADING")
        .map((s) => String(s.baseAsset || "").toUpperCase())
        .filter(Boolean);
    },
  },
  {
    id: "aster",
    label: "Aster",
    reach: async () => {
      const data = await fetchJson("https://fapi.asterdex.com/fapi/v1/exchangeInfo", {
        timeoutMs: 20000,
      });
      return (data && data.symbols ? data.symbols : [])
        .filter((s) => s && s.status !== "BREAK")
        .map((s) => String(s.baseAsset || "").toUpperCase())
        .filter(Boolean);
    },
  },
  // Declared so their absence is visible. Both refuse connections from this
  // network; left here so a future run on another host picks them up by
  // deleting one line rather than rediscovering the endpoints.
  {
    id: "okx",
    label: "OKX",
    reach: async () => {
      const data = await fetchJson(
        "https://www.okx.com/api/v5/public/instruments?instType=SWAP", { timeoutMs: 15000 });
      return (data && data.data ? data.data : [])
        .map((s) => String(s.ctValCcy || (s.instId || "").split("-")[0] || "").toUpperCase())
        .filter(Boolean);
    },
  },
  {
    id: "bybit",
    label: "Bybit",
    reach: async () => {
      const data = await fetchJson(
        "https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000",
        { timeoutMs: 15000 });
      return ((data && data.result && data.result.list) || [])
        .map((s) => String(s.baseCoin || "").toUpperCase())
        .filter(Boolean);
    },
  },
];

/**
 * Every venue, fetched in parallel, each one's failure its own.
 *
 * Returns the shape written to perps.json: a symbol -> venue list index, plus
 * per-venue status so a reader can tell "no perp anywhere" from "we could not
 * check three of five venues".
 */
async function fetchPerpVenues() {
  const venues = {};
  const bySymbol = {};

  await Promise.all(VENUES.map(async (venue) => {
    const startedAt = Date.now();
    try {
      const symbols = await venue.reach();
      const unique = [...new Set(symbols)];
      venues[venue.id] = {
        label: venue.label, ok: true, markets: unique.length,
        ms: Date.now() - startedAt, error: null,
      };
      for (const symbol of unique) {
        if (!bySymbol[symbol]) bySymbol[symbol] = [];
        bySymbol[symbol].push(venue.id);
      }
    } catch (error) {
      venues[venue.id] = {
        label: venue.label, ok: false, markets: 0,
        ms: Date.now() - startedAt, error: String(error.message || error).slice(0, 160),
      };
    }
  }));

  const reachable = Object.values(venues).filter((v) => v.ok).length;
  return {
    writtenAt: Date.now(),
    venues: venues,
    venuesReachable: reachable,
    venuesTotal: VENUES.length,
    symbols: bySymbol,
    symbolCount: Object.keys(bySymbol).length,
    match: "by symbol, not contract address - a token sharing a ticker with a " +
      "listed asset will appear listed. Treat as a strong hint, not proof.",
  };
}

module.exports = { fetchPerpVenues, VENUES };
