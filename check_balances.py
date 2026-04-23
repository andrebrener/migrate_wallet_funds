#!/usr/bin/env python3
"""Print a token-balance breakdown across every source in config.json.

Filters:
  - skips balances below DUST_USD (env, default $1) USD
  - skips tokens without an Alchemy USD price (probable scams)

Usage: python3 check_balances.py
"""

import os
import sys
from collections import defaultdict
from decimal import Decimal

from common import (
    NATIVE_META,
    NETWORKS,
    extract_price,
    fetch_balances,
    fmt_usd,
    load_config,
    parse_amount,
)

DUST_THRESHOLD_USD = Decimal(os.environ.get("DUST_USD", "1"))


def main():
    config = load_config()
    wallets = [(addr, meta["trezor"]) for addr, meta in config["sources"].items()]
    wallet_labels = {a.lower(): t for a, t in wallets}

    print(f"Querying {len(wallets)} wallets across {len(NETWORKS)} chains...", file=sys.stderr)
    all_tokens = fetch_balances([a for a, _ in wallets])

    rows = []
    skipped_no_price = 0
    skipped_dust = 0
    for t in all_tokens:
        addr = (t.get("address") or "").lower()
        network = t.get("network") or "?"
        token_addr = t.get("tokenAddress")
        meta = t.get("tokenMetadata") or {}
        if token_addr is None:
            native = NATIVE_META.get(network, {})
            symbol = native.get("symbol", "NATIVE")
            decimals = native.get("decimals", 18)
        else:
            symbol = meta.get("symbol") or "?"
            decimals = meta.get("decimals")
        balance = parse_amount(t.get("tokenBalance"), decimals)
        if balance is None or balance == 0:
            continue
        price = extract_price(t.get("tokenPrices"))
        if price is None:
            skipped_no_price += 1
            continue
        usd_value = balance * price
        if usd_value < DUST_THRESHOLD_USD:
            skipped_dust += 1
            continue
        rows.append({
            "address": addr,
            "trezor": wallet_labels.get(addr, "?"),
            "network": network,
            "symbol": symbol,
            "token_address": t.get("tokenAddress") or "NATIVE",
            "balance": balance,
            "price": price,
            "usd": usd_value,
        })

    rows.sort(key=lambda r: r["usd"], reverse=True)

    print()
    header = f"{'Wallet':18} {'Trezor':16} {'Chain':14} {'Token':10} {'Balance':>18} {'Price':>14} {'USD':>14}"
    print(header)
    print("-" * len(header))
    for r in rows:
        short = r["address"][:6] + "…" + r["address"][-4:]
        bal_s = f"{r['balance']:,.6f}".rstrip("0").rstrip(".") or "0"
        price_s = f"${r['price']:,.6f}".rstrip("0").rstrip(".")
        print(f"{short:18} {r['trezor']:16} {r['network']:14} {r['symbol']:10} {bal_s:>18} {price_s:>14} {fmt_usd(r['usd']):>14}")
    print("-" * len(header))
    total = sum((r["usd"] for r in rows), Decimal(0))
    print(f"TOTAL: {fmt_usd(total)}")
    print(f"(skipped: {skipped_no_price} without price / {skipped_dust} dust < {fmt_usd(DUST_THRESHOLD_USD)})")

    by_wallet = defaultdict(lambda: Decimal(0))
    for r in rows:
        by_wallet[(r["address"], r["trezor"])] += r["usd"]
    print("\nBy wallet:")
    for (addr, trezor), usd in sorted(by_wallet.items(), key=lambda x: x[1], reverse=True):
        print(f"  {addr}  {trezor:16} {fmt_usd(usd)}")

    by_chain = defaultdict(lambda: Decimal(0))
    for r in rows:
        by_chain[r["network"]] += r["usd"]
    print("\nBy chain:")
    for net, usd in sorted(by_chain.items(), key=lambda x: x[1], reverse=True):
        print(f"  {net:16} {fmt_usd(usd)}")

    by_trezor = defaultdict(lambda: Decimal(0))
    for r in rows:
        by_trezor[r["trezor"]] += r["usd"]
    print("\nBy Trezor:")
    for trezor, usd in sorted(by_trezor.items(), key=lambda x: x[1], reverse=True):
        print(f"  {trezor:16} {fmt_usd(usd)}")

    tx_per_wallet = defaultdict(int)
    tx_per_wallet_chain = defaultdict(lambda: defaultdict(list))
    for r in rows:
        tx_per_wallet[(r["address"], r["trezor"])] += 1
        tx_per_wallet_chain[(r["address"], r["trezor"])][r["network"]].append(r["symbol"])

    total_tx = sum(tx_per_wallet.values())
    print(f"\nTotal tx to sign: {total_tx}")
    print("\nTx per wallet (chain breakdown):")
    for (addr, trezor), count in sorted(tx_per_wallet.items(), key=lambda x: x[1], reverse=True):
        chains = tx_per_wallet_chain[(addr, trezor)]
        chain_str = ", ".join(
            f"{net.replace('-mainnet', '')}:{len(syms)} ({'+'.join(syms)})"
            for net, syms in sorted(chains.items(), key=lambda x: -len(x[1]))
        )
        print(f"  {addr}  {trezor:16} {count:>3} tx  →  {chain_str}")


if __name__ == "__main__":
    main()
