#!/usr/bin/env python3
"""Interactive planner.

Flow:
  1. Fetch balances for every source in config.json.
  2. Interactively group sources (1 prompt per source).
  3. For each group, compute how many destination wallets are needed
     (ceil(group_total / MAX_USD_PER_WALLET)) and prompt for each address.
  4. Bin-pack tokens into destinations (greedy, soft cap with tolerance).
     Native ETH on mainnet can be split across destinations with fixed amounts.
  5. Write transfer_plan.csv and persist groups/destinations in config.json.

Run: python3 plan.py
Then: node sign_and_send.js
"""

import csv
import math
import os
import sys
from decimal import ROUND_DOWN, Decimal

from common import (
    NATIVE_META,
    NETWORKS,
    extract_price,
    fetch_balances,
    fmt_usd,
    load_config,
    parse_amount,
    save_config,
)

MAX_USD_PER_WALLET = Decimal(os.environ.get("MAX_USD_PER_WALLET", "100000"))
MIN_USD_TO_TRANSFER = Decimal(os.environ.get("MIN_USD_TO_TRANSFER", "3"))
CAP_TOLERANCE_PCT = Decimal(os.environ.get("CAP_TOLERANCE_PCT", "10"))
CAP_WITH_TOLERANCE = MAX_USD_PER_WALLET * (Decimal(1) + CAP_TOLERANCE_PCT / Decimal(100))

CSV_PATH = "transfer_plan.csv"
WEI = Decimal("0.000000000000000001")


def collect_items(sources, raw_tokens):
    """Turn Alchemy tokens into (source, chain, token) items with USD values."""
    items = []
    for t in raw_tokens:
        addr = (t.get("address") or "").lower()
        if addr not in sources:
            continue
        network = t.get("network")
        token_addr = t.get("tokenAddress")
        if token_addr is None:
            native = NATIVE_META.get(network, {"symbol": "?", "decimals": 18})
            symbol = native["symbol"]
            decimals = native["decimals"]
        else:
            meta = t.get("tokenMetadata") or {}
            symbol = meta.get("symbol") or "?"
            decimals = meta.get("decimals")
        balance = parse_amount(t.get("tokenBalance"), decimals)
        if balance is None or balance == 0:
            continue
        price = extract_price(t.get("tokenPrices"))
        if price is None:
            continue
        usd = balance * price
        if usd < MIN_USD_TO_TRANSFER:
            continue
        items.append({
            "source": addr,
            "source_label": sources[addr]["label"],
            "trezor": sources[addr]["trezor"],
            "chain": network,
            "token_address": token_addr or "NATIVE",
            "symbol": symbol,
            "decimals": decimals,
            "balance": balance,
            "usd_price": price,
            "usd_value": usd,
        })
    return items


def per_source_totals(items):
    totals = {}
    counts = {}
    for i in items:
        totals[i["source"]] = totals.get(i["source"], Decimal(0)) + i["usd_value"]
        counts[i["source"]] = counts.get(i["source"], 0) + 1
    return totals, counts


def prompt_yes_no(prompt, default=False):
    tag = "[Y/n]" if default else "[y/N]"
    while True:
        a = input(f"{prompt} {tag}: ").strip().lower()
        if not a:
            return default
        if a in ("y", "yes"):
            return True
        if a in ("n", "no"):
            return False


def group_sources_interactive(sources, totals, counts):
    active = [a for a in sources if a in totals]
    active.sort(key=lambda a: -totals[a])

    zero = [a for a in sources if a not in totals]
    if zero:
        print(f"\n{len(zero)} source{'s' if len(zero)!=1 else ''} have no transferable balance (skipped):")
        for a in zero:
            print(f"  {a}  {sources[a]['label']}")

    print("\nAssign each source to a group.")
    print("  <n>   = add to existing group number n")
    print("  new   = create a new group")
    print("  solo  = new group with just this source (same as 'new' with one wallet)")
    print("  skip  = do not touch this wallet")
    print("  back  = redo the previous source\n")

    groups = {}  # name -> [addresses]
    history = []  # stack of (addr, group_name or None for skip)
    i = 0
    while i < len(active):
        addr = active[i]
        info = sources[addr]
        print(f"\n[{i+1}/{len(active)}] {info['label']}  ({addr})")
        print(f"  trezor={info['trezor']}   total={fmt_usd(totals[addr])}   tokens={counts[addr]}")

        if groups:
            print("  existing groups:")
            for gi, (name, addrs) in enumerate(groups.items(), start=1):
                g_total = sum((totals[a] for a in addrs), Decimal(0))
                n_slots = max(1, math.ceil(g_total / MAX_USD_PER_WALLET))
                print(f"    [{gi}] {name}  ({len(addrs)} wallet{'s' if len(addrs)!=1 else ''}, {fmt_usd(g_total)}, {n_slots} dest slot{'s' if n_slots!=1 else ''})")

        choice = input("  choice: ").strip().lower()

        if choice == "back":
            if not history:
                print("  nothing to undo")
                continue
            last_addr, last_group = history.pop()
            if last_group is not None and last_addr in groups.get(last_group, []):
                groups[last_group].remove(last_addr)
                if not groups[last_group]:
                    del groups[last_group]
            i -= 1
            continue

        if choice == "skip":
            history.append((addr, None))
            i += 1
            continue

        if choice in ("new", "solo"):
            default = f"Group{len(groups) + 1}"
            name = input(f"  group name [{default}]: ").strip() or default
            if name in groups:
                print(f"  '{name}' already exists; try another")
                continue
            groups[name] = [addr]
            history.append((addr, name))
            i += 1
            continue

        try:
            idx = int(choice)
            if 1 <= idx <= len(groups):
                name = list(groups.keys())[idx - 1]
                groups[name].append(addr)
                history.append((addr, name))
                i += 1
                continue
        except ValueError:
            pass

        print("  invalid; try again")

    return groups


def prompt_destinations(groups, totals, existing=None):
    """Ask for destination addresses for each group. Returns (destinations, group_dests)."""
    existing = existing or {}
    destinations = {}
    group_dests = {}

    for name, addrs in groups.items():
        g_total = sum((totals[a] for a in addrs), Decimal(0))
        n = max(1, math.ceil(g_total / MAX_USD_PER_WALLET))
        print(f"\nGroup {name}: {fmt_usd(g_total)} across {len(addrs)} wallet{'s' if len(addrs)!=1 else ''} → {n} destination{'s' if n!=1 else ''}")

        prev_labels = existing.get(name, [])
        labels = []
        for slot in range(1, n + 1):
            default_label = f"{name}-{slot}"
            prev_label = prev_labels[slot - 1] if slot - 1 < len(prev_labels) else None
            prev_addr = existing.get("_destinations", {}).get(prev_label) if prev_label else None

            while True:
                prompt = f"  [{slot}/{n}] address"
                if prev_addr:
                    prompt += f" [{prev_addr}]"
                prompt += ": "
                addr_in = input(prompt).strip().lower() or (prev_addr or "")
                if not (addr_in.startswith("0x") and len(addr_in) == 42):
                    print("    not a valid 0x address")
                    continue
                if addr_in in destinations.values():
                    print("    that address was already used in this run")
                    continue
                label_default = prev_label or default_label
                label_in = input(f"        label [{label_default}]: ").strip() or label_default
                if label_in in destinations:
                    print(f"    label '{label_in}' already used")
                    continue
                destinations[label_in] = addr_in
                labels.append(label_in)
                break
        group_dests[name] = labels
    return destinations, group_dests


def bin_pack(group_items, dest_labels, destinations):
    """Greedy bin-packing for one group.

    ERC-20 and non-ETH-mainnet native tokens are atomic — whole balance goes to one dest.
    Native ETH on mainnet (per source) can be split into fixed+rest chunks across dests.

    Returns: (rows, warnings)
    """
    dest_state = {label: {"used": Decimal(0), "rows": []} for label in dest_labels}
    warnings = []

    atomic = []
    eth_mainnet = []
    for it in group_items:
        if it["token_address"] == "NATIVE" and it["chain"] == "eth-mainnet":
            eth_mainnet.append(it)
        else:
            atomic.append(it)

    # Atomic items: biggest first, into dest with least usage
    atomic.sort(key=lambda x: -x["usd_value"])
    for it in atomic:
        best = min(dest_state.keys(), key=lambda l: dest_state[l]["used"])
        new_used = dest_state[best]["used"] + it["usd_value"]
        if new_used > CAP_WITH_TOLERANCE:
            warnings.append(
                f"{it['source_label']} {it['symbol']} on {it['chain']} ({fmt_usd(it['usd_value'])}) "
                f"pushes {best} to {fmt_usd(new_used)} — over cap+tolerance ({fmt_usd(CAP_WITH_TOLERANCE)})"
            )
        dest_state[best]["rows"].append({
            **it,
            "destination": best,
            "destination_address": destinations[best],
            "amount": it["balance"],
            "amount_usd": it["usd_value"],
            "note": "" if it["token_address"] != "NATIVE" else "native — send max last to keep gas in the wallet",
        })
        dest_state[best]["used"] = new_used

    # ETH mainnet: one per source; may split across dests based on remaining capacity.
    for it in eth_mainnet:
        remaining_balance = it["balance"]
        remaining_usd = it["usd_value"]
        price = it["usd_price"]

        # Destinations that still have room, sorted by remaining capacity desc
        caps = [(l, MAX_USD_PER_WALLET - dest_state[l]["used"]) for l in dest_labels]
        caps = [(l, c) for l, c in caps if c > Decimal(0)]
        caps.sort(key=lambda x: -x[1])

        if not caps:
            # No room anywhere — dump on least-used dest, flag
            least = min(dest_state.keys(), key=lambda l: dest_state[l]["used"])
            dest_state[least]["rows"].append({
                **it,
                "destination": least,
                "destination_address": destinations[least],
                "amount": remaining_balance,
                "amount_usd": remaining_usd,
                "note": "native — send max last to keep gas in the wallet",
            })
            dest_state[least]["used"] += remaining_usd
            warnings.append(
                f"{it['source_label']} ETH ({fmt_usd(remaining_usd)}) went to already-full {least}"
            )
            continue

        # Fits entirely in one dest?
        if remaining_usd <= caps[0][1]:
            label = caps[0][0]
            dest_state[label]["rows"].append({
                **it,
                "destination": label,
                "destination_address": destinations[label],
                "amount": remaining_balance,
                "amount_usd": remaining_usd,
                "note": "native — send max last to keep gas in the wallet",
            })
            dest_state[label]["used"] += remaining_usd
            continue

        # Split: fixed amounts into all but last, 'rest' into last
        for idx, (label, cap_avail) in enumerate(caps):
            if remaining_usd <= 0:
                break
            is_last = idx == len(caps) - 1
            if not is_last and remaining_usd > cap_avail:
                # Fixed ETH = cap_avail / price, rounded DOWN to wei precision
                take_eth = (cap_avail / price).quantize(WEI, rounding=ROUND_DOWN)
                if take_eth <= 0:
                    continue
                take_usd = take_eth * price
                dest_state[label]["rows"].append({
                    **it,
                    "destination": label,
                    "destination_address": destinations[label],
                    "amount": take_eth,
                    "amount_usd": take_usd,
                    "note": "fixed ETH",
                })
                dest_state[label]["used"] += take_usd
                remaining_balance -= take_eth
                remaining_usd -= take_usd
            else:
                # Last (or whatever fits) — send max
                dest_state[label]["rows"].append({
                    **it,
                    "destination": label,
                    "destination_address": destinations[label],
                    "amount": remaining_balance,
                    "amount_usd": remaining_usd,
                    "note": "rest — send max, leave small buffer for gas",
                })
                dest_state[label]["used"] += remaining_usd
                remaining_balance = Decimal(0)
                remaining_usd = Decimal(0)
                break

    # Flatten
    rows = []
    for state in dest_state.values():
        rows.extend(state["rows"])
    return rows, warnings, dest_state


def assign_steps(rows):
    """Per (source, chain): ERC-20 by USD desc, then native fixed, then native rest."""
    buckets = {}
    for r in rows:
        buckets.setdefault((r["source"], r["chain"]), []).append(r)
    for _, rs in buckets.items():
        erc20 = [r for r in rs if r["token_address"] != "NATIVE"]
        native_fixed = [r for r in rs if r["token_address"] == "NATIVE" and "rest" not in r["note"]]
        native_rest = [r for r in rs if r["token_address"] == "NATIVE" and "rest" in r["note"]]
        erc20.sort(key=lambda r: -float(r["amount_usd"]))
        for i, r in enumerate(erc20 + native_fixed + native_rest, start=1):
            r["step"] = i


def write_csv(rows):
    rows = sorted(rows, key=lambda r: (r["trezor"], r["source_label"], r["chain"], r["step"]))
    with open(CSV_PATH, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "trezor", "source_label", "source_address", "chain", "step",
            "token_symbol", "token_address",
            "amount", "usd_price", "amount_usd",
            "destination", "destination_address", "note",
        ])
        for r in rows:
            w.writerow([
                r["trezor"], r["source_label"], r["source"], r["chain"], r["step"],
                r["symbol"], r["token_address"],
                f"{r['amount']}", f"{r['usd_price']}", f"{r['amount_usd']:.2f}",
                r["destination"], r["destination_address"], r["note"],
            ])


def main():
    config = load_config()
    sources = config["sources"]

    print(f"Sources:              {len(sources)}")
    print(f"Cap per destination:  {fmt_usd(MAX_USD_PER_WALLET)}  (tolerance ±{CAP_TOLERANCE_PCT}%)")
    print(f"Min transfer value:   {fmt_usd(MIN_USD_TO_TRANSFER)}")
    print(f"\nFetching balances across {len(NETWORKS)} chains...", flush=True)

    raw = fetch_balances(sources.keys())
    items = collect_items(sources, raw)
    if not items:
        sys.exit("No transferable balances found (everything is dust or has no USD price).")

    totals, counts = per_source_totals(items)
    grand_total = sum(totals.values(), Decimal(0))
    print(f"Found {fmt_usd(grand_total)} to move across {len(totals)} source{'s' if len(totals)!=1 else ''}.")

    # Offer to reuse existing plan
    existing_groups = config.get("groups") or {}
    existing_dests = config.get("destinations") or {}
    reuse_groups = False
    reuse_dests = False
    if existing_groups:
        print(f"\nconfig.json already has {len(existing_groups)} group{'s' if len(existing_groups)!=1 else ''}.")
        if prompt_yes_no("Reuse existing groups?", default=True):
            reuse_groups = True
            if existing_dests and prompt_yes_no("Reuse existing destination addresses?", default=True):
                reuse_dests = True

    if reuse_groups:
        groups = {name: list(g["sources"]) for name, g in existing_groups.items()}
        # Validate that every grouped source is still in config sources AND has balances
        for name, addrs in groups.items():
            missing = [a for a in addrs if a not in sources]
            if missing:
                sys.exit(f"Group '{name}' references unknown source(s): {missing}. Edit config.json and re-run.")
    else:
        groups = group_sources_interactive(sources, totals, counts)
        if not groups:
            sys.exit("No groups defined; nothing to plan.")

    # Show summary and confirm
    print("\n" + "=" * 60)
    print("Group summary:")
    for name, addrs in groups.items():
        g_total = sum((totals.get(a, Decimal(0)) for a in addrs), Decimal(0))
        n_slots = max(1, math.ceil(g_total / MAX_USD_PER_WALLET))
        print(f"  {name}: {len(addrs)} wallet{'s' if len(addrs)!=1 else ''}, {fmt_usd(g_total)} → {n_slots} destination{'s' if n_slots!=1 else ''}")
        for a in addrs:
            print(f"      - {sources[a]['label']:30} {fmt_usd(totals.get(a, Decimal(0))):>14}")
    print("=" * 60)
    if not prompt_yes_no("Confirm groups?", default=True):
        sys.exit("Aborted. Re-run to redo grouping.")

    # Destinations
    existing_for_prompt = {}
    if reuse_dests:
        existing_for_prompt = {name: g.get("destinations", []) for name, g in existing_groups.items()}
        existing_for_prompt["_destinations"] = existing_dests
    print("\nEnter destination addresses:")
    destinations, group_dests = prompt_destinations(groups, totals, existing=existing_for_prompt)

    # Pack each group
    all_rows = []
    all_warnings = []
    for name, addrs in groups.items():
        group_items = [i for i in items if i["source"] in addrs]
        rows, warnings, _ = bin_pack(group_items, group_dests[name], destinations)
        all_rows.extend(rows)
        if warnings:
            all_warnings.append((name, warnings))

    if all_warnings:
        print("\nCap warnings (soft cap exceeded):")
        for name, warns in all_warnings:
            print(f"  {name}:")
            for w in warns:
                print(f"    - {w}")

    assign_steps(all_rows)
    write_csv(all_rows)

    # Persist groups + destinations to config.json for auditability and re-runs
    config["destinations"] = destinations
    config["groups"] = {
        name: {"sources": addrs, "destinations": group_dests[name]}
        for name, addrs in groups.items()
    }
    save_config(config)

    total = sum((Decimal(str(r["amount_usd"])) for r in all_rows), Decimal(0))
    print(f"\n✓ Wrote {len(all_rows)} rows to {CSV_PATH}  ({fmt_usd(total)})")
    print(f"✓ Saved groups and destinations to config.json")
    print("\nReview the CSV, then run: node sign_and_send.js")


if __name__ == "__main__":
    main()
