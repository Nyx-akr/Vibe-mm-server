"use strict";

/**
 * Chain registry and feed URLs.
 *
 * Pure lookup tables - no fetching, no math. The server needs these to build
 * upstream URLs; the app never sees them except as the `chain` string it
 * already sends.
 */

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const DS_BASE = "https://api.dexscreener.com";
const USER_AGENT = "vibescreener-server/2.0 (+raw-feed)";

const CHAINS = Object.freeze({
  solana: { gt: "solana", ds: "solana", label: "Solana", nativeSymbol: "SOL" },
  ethereum: { gt: "eth", ds: "ethereum", label: "Ethereum", nativeSymbol: "ETH" },
  base: { gt: "base", ds: "base", label: "Base", nativeSymbol: "ETH" },
  bsc: { gt: "bsc", ds: "bsc", label: "BNB Chain", nativeSymbol: "BNB" },
  arbitrum: { gt: "arbitrum", ds: "arbitrum", label: "Arbitrum", nativeSymbol: "ETH" },
  polygon: { gt: "polygon_pos", ds: "polygon", label: "Polygon", nativeSymbol: "POL" },
  avalanche: { gt: "avax", ds: "avalanche", label: "Avalanche", nativeSymbol: "AVAX" },
  sui: { gt: "sui-network", ds: "sui", label: "Sui", nativeSymbol: "SUI" },
  hyperevm: { gt: "hyperevm", ds: "hyperevm", label: "HyperEVM", nativeSymbol: "HYPE" },
  robinhood: { gt: "robinhood", ds: "robinhood", label: "Robinhood Chain", nativeSymbol: "ETH" },
  ton: { gt: "ton", ds: "ton", label: "TON", nativeSymbol: "TON" },
  monad: { gt: "monad", ds: "monad", label: "Monad", nativeSymbol: "MON" },
  abstract: { gt: "abstract", ds: "abstract", label: "Abstract", nativeSymbol: "ETH" },
  berachain: { gt: "berachain", ds: "berachain", label: "Berachain", nativeSymbol: "BERA" },
  unichain: { gt: "unichain", ds: "unichain", label: "Unichain", nativeSymbol: "ETH" },
  sonic: { gt: "sonic", ds: "sonic", label: "Sonic", nativeSymbol: "S" },
  plasma: { gt: "plasma", ds: "plasma", label: "Plasma", nativeSymbol: "XPL" },
});

const CHAIN_ALIASES = Object.freeze({
  sol: "solana", eth: "ethereum", mainnet: "ethereum", bnb: "bsc",
  "binance-smart-chain": "bsc", matic: "polygon", polygon_pos: "polygon",
  arb: "arbitrum", avax: "avalanche", hyperliquid: "hyperevm", hype: "hyperevm",
  rhc: "robinhood", bera: "berachain", uni: "unichain", xpl: "plasma",
});

const FEEDS = Object.freeze({
  trending: (network) =>
    GT_BASE + "/networks/" + network + "/trending_pools?include=base_token,quote_token,dex&page=1",
  new: (network) =>
    GT_BASE + "/networks/" + network + "/new_pools?include=base_token,quote_token,dex&page=1",
  top: (network) =>
    GT_BASE + "/networks/" + network + "/pools?include=base_token,quote_token,dex&sort=h24_volume_usd_desc&page=1",
});

function resolveChain(input) {
  const key = String(input || "solana").trim().toLowerCase();
  const canonical = CHAIN_ALIASES[key] || key;
  const chain = CHAINS[canonical];
  return chain ? Object.assign({ key: canonical }, chain) : null;
}

module.exports = { GT_BASE, DS_BASE, USER_AGENT, CHAINS, CHAIN_ALIASES, FEEDS, resolveChain };
