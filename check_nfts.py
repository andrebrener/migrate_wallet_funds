#!/usr/bin/env python3
"""Print NFT holdings across every source in config.json.

  - skips anything Alchemy flagged as isSpam
  - rough USD estimate: OpenSea floor * chain-native USD price (refresh manually if stale)
"""

import json
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from decimal import Decimal

from common import ALCHEMY_API_KEY, NETWORKS, fmt_usd, load_config

# Rough native-token USD prices. Refresh manually.
NATIVE_USD = {
    "eth-mainnet":   Decimal("2320"),
    "base-mainnet":  Decimal("2320"),
    "arb-mainnet":   Decimal("2320"),
    "opt-mainnet":   Decimal("2320"),
    "matic-mainnet": Decimal("0.093"),
    "bnb-mainnet":   Decimal("630"),
}


def fetch_contracts(address, network):
    base = f"https://{network}.g.alchemy.com/nft/v3/{ALCHEMY_API_KEY}/getContractsForOwner"
    all_contracts = []
    page_key = None
    while True:
        url = f"{base}?owner={address}&pageSize=100"
        if page_key:
            url += f"&pageKey={page_key}"
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            print(f"  ! {network} {address}: HTTP {e.code} {e.read().decode()[:200]}", file=sys.stderr)
            return []
        all_contracts.extend(data.get("contracts", []))
        page_key = data.get("pageKey")
        if not page_key:
            break
    return all_contracts


def main():
    config = load_config()
    wallets = [(addr, meta["trezor"]) for addr, meta in config["sources"].items()]
    rows = []
    print(f"Querying {len(wallets)} wallets x {len(NETWORKS)} chains for NFTs...", file=sys.stderr)
    for addr, trezor in wallets:
        for net in NETWORKS:
            for c in fetch_contracts(addr, net):
                if c.get("isSpam"):
                    continue
                n_tokens = int(c.get("numDistinctTokensOwned") or 0)
                if n_tokens == 0:
                    continue
                osm = c.get("openSeaMetadata") or {}
                floor = osm.get("floorPrice")
                try:
                    floor_eth = Decimal(str(floor)) if floor else Decimal(0)
                except Exception:
                    floor_eth = Decimal(0)
                native_usd = NATIVE_USD.get(net, Decimal(0))
                est_usd = floor_eth * native_usd * Decimal(n_tokens)
                rows.append({
                    "address": addr.lower(),
                    "trezor": trezor,
                    "network": net,
                    "contract": c.get("address"),
                    "name": c.get("name") or (osm.get("collectionName")) or "?",
                    "symbol": c.get("symbol") or "",
                    "type": c.get("tokenType") or "",
                    "tokens": n_tokens,
                    "floor": floor_eth,
                    "est_usd": est_usd,
                    "safelist": osm.get("safelistRequestStatus"),
                })

    rows.sort(key=lambda r: (r["est_usd"], r["tokens"]), reverse=True)

    if not rows:
        print("\nNo NFTs (non-spam) found across any wallet/chain.")
        return

    print()
    header = f"{'Wallet':18} {'Trezor':16} {'Chain':14} {'Type':8} {'Tokens':>6} {'Floor':>10} {'Est USD':>12} Collection"
    print(header)
    print("-" * 130)
    for r in rows:
        short = r["address"][:6] + "…" + r["address"][-4:]
        floor_s = f"{r['floor']:.4f}".rstrip("0").rstrip(".") or "0"
        name = r["name"][:40]
        tag = "✓" if r["safelist"] in ("verified", "approved") else " "
        print(f"{short:18} {r['trezor']:16} {r['network']:14} {r['type']:8} {r['tokens']:>6} {floor_s:>10} {fmt_usd(r['est_usd']):>12} {tag} {name}")

    print("\nNFTs per wallet (count = tx needed to move everything):")
    by_wallet = defaultdict(lambda: {"tokens": 0, "usd": Decimal(0), "contracts": 0, "chains": defaultdict(int)})
    for r in rows:
        k = (r["address"], r["trezor"])
        by_wallet[k]["tokens"] += r["tokens"]
        by_wallet[k]["usd"] += r["est_usd"]
        by_wallet[k]["contracts"] += 1
        by_wallet[k]["chains"][r["network"].replace("-mainnet", "")] += r["tokens"]
    for (addr, trezor), v in sorted(by_wallet.items(), key=lambda x: -x[1]["tokens"]):
        chains = ", ".join(f"{n}:{c}" for n, c in sorted(v["chains"].items(), key=lambda x: -x[1]))
        print(f"  {addr}  {trezor:16} {v['tokens']:>3} NFTs ({v['contracts']} collections, {chains})  ~{fmt_usd(v['usd'])}")

    total_tokens = sum(v["tokens"] for v in by_wallet.values())
    total_usd = sum(v["usd"] for v in by_wallet.values())
    print(f"\nTOTAL NFTs: {total_tokens} tokens across {len(rows)} collections  ~{fmt_usd(total_usd)}")


if __name__ == "__main__":
    main()
