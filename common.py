"""Shared helpers: env loading, config I/O, Alchemy API calls."""

import json
import os
import sys
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path

CONFIG_PATH = Path(__file__).with_name("config.json")
ENV_PATH = Path(__file__).with_name(".env")

NETWORKS = [
    "eth-mainnet",
    "base-mainnet",
    "arb-mainnet",
    "opt-mainnet",
    "matic-mainnet",
    "bnb-mainnet",
]

NATIVE_META = {
    "eth-mainnet":   {"symbol": "ETH",   "decimals": 18},
    "base-mainnet":  {"symbol": "ETH",   "decimals": 18},
    "arb-mainnet":   {"symbol": "ETH",   "decimals": 18},
    "opt-mainnet":   {"symbol": "ETH",   "decimals": 18},
    "matic-mainnet": {"symbol": "MATIC", "decimals": 18},
    "bnb-mainnet":   {"symbol": "BNB",   "decimals": 18},
}


def _load_env():
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

ALCHEMY_API_KEY = os.environ.get("ALCHEMY_API_KEY")
if not ALCHEMY_API_KEY:
    sys.exit("Missing ALCHEMY_API_KEY. Copy .env.example to .env and set it.")


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH.name}. Copy config.example.json and fill in sources.")
    raw = json.loads(CONFIG_PATH.read_text())
    if "sources" not in raw or not raw["sources"]:
        sys.exit("config.json must contain a non-empty 'sources' object.")
    # Normalize source addresses to lowercase
    raw["sources"] = {a.lower(): v for a, v in raw["sources"].items()}
    return raw


def save_config(config):
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n")


def http_post(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def fetch_balances(addresses, batch_size=2):
    """Fetch token balances across all configured NETWORKS via Alchemy Portfolio API."""
    endpoint = f"https://api.g.alchemy.com/data/v1/{ALCHEMY_API_KEY}/assets/tokens/by-address"
    addresses = list(addresses)
    all_tokens = []
    for i in range(0, len(addresses), batch_size):
        batch = addresses[i:i + batch_size]
        body = {
            "addresses": [{"address": a, "networks": NETWORKS} for a in batch],
            "withMetadata": True,
            "withPrices": True,
            "includeNativeTokens": True,
        }
        page_key = None
        while True:
            payload = dict(body)
            if page_key:
                payload["pageKey"] = page_key
            data = http_post(endpoint, payload).get("data", {})
            all_tokens.extend(data.get("tokens", []))
            page_key = data.get("pageKey")
            if not page_key:
                break
    return all_tokens


def parse_amount(raw, decimals):
    if raw is None or decimals is None:
        return None
    try:
        n = int(raw, 16) if isinstance(raw, str) and raw.startswith("0x") else int(raw)
    except Exception:
        return None
    return Decimal(n) / (Decimal(10) ** Decimal(decimals))


def extract_price(prices):
    if not prices:
        return None
    for p in prices:
        if p.get("currency") == "usd":
            try:
                return Decimal(str(p.get("value")))
            except Exception:
                return None
    return None


def fmt_usd(v):
    return f"${v:,.2f}"
