# trezor-consolidator

Plan and execute a multi-wallet, multi-chain token consolidation from
Trezor-controlled EOAs. Built around three steps:

1. **List** — you provide source wallets and a per-destination USD cap.
2. **Plan** — an interactive wizard fetches balances, lets you group sources,
   asks how many destinations each group needs, bin-packs tokens into those
   destinations, and writes `transfer_plan.csv`.
3. **Sign** — a signer iterates the CSV one tx at a time, asks the Trezor
   to sign each one, broadcasts, waits for confirmation, verifies the
   destination balance changed by the expected amount, and logs everything.

Supported chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain.

## Requirements

- Node.js 20+
- Python 3.9+
- [Alchemy](https://www.alchemy.com/) API key (free tier works)
- For the signer: a Trezor Model One (firmware ≥ 1.12 for EIP-1559) and
  [Trezor Suite](https://trezor.io/trezor-suite) open — it bundles the bridge.

## Setup

```bash
npm install

# 1. API key + cap
cp .env.example .env
$EDITOR .env

# 2. List the source wallets you want to drain
cp config.example.json config.json
$EDITOR config.json
```

Both `.env` and `config.json` are gitignored.

### `.env`

| var                   | meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `ALCHEMY_API_KEY`     | Alchemy key (required).                                                         |
| `MAX_USD_PER_WALLET`  | Cap per destination (default `100000`).                                         |
| `MIN_USD_TO_TRANSFER` | Token balances below this are treated as dust and ignored (default `3`).        |
| `CAP_TOLERANCE_PCT`   | How far a destination may exceed the cap when a token balance can't be split (default `10`, i.e. 110% of cap). |

### `config.json`

You fill in `sources` only. For every wallet you want to consolidate from:

```json
{
  "sources": {
    "0xabc...": { "label": "Hot wallet", "trezor": "TrezorA" },
    "0xdef...": { "label": "Cold storage", "trezor": "TrezorB" }
  }
}
```

The `label` is for your eyes; the `trezor` string groups wallets that live on
the same physical device (the signer uses this to skip sources that aren't on
the currently-connected device).

The wizard writes `destinations` and `groups` into this same file after you
run it — you don't need to write those by hand.

## Flow

### 1. (Optional) Inspect balances

```bash
python3 check_balances.py   # per-wallet / per-chain / per-Trezor USD breakdown
python3 check_nfts.py       # NFT holdings (rough floor-price estimate)
```

### 2. Plan

```bash
python3 plan.py
```

Walks you through:

1. **Fetch balances** for every source and chain.
2. **Group sources.** Once per source with a balance above the dust filter,
   you pick: add to an existing group, create a new group, mark as solo,
   or skip. Sources that logically pool funds together (e.g. yours vs. a
   family member's) go in the same group. `back` undoes the last choice.
3. **Confirm group summary.** Each group shows its combined USD and how many
   destinations it needs (`ceil(group_total / MAX_USD_PER_WALLET)`).
4. **Enter destination addresses.** For each slot the wizard auto-suggests a
   label (e.g. `Family-1`, `Family-2`); override if you like.
5. **Bin-pack.** Tokens are assigned greedily biggest-first to the destination
   with the most remaining capacity. Native ETH on mainnet can be split
   across multiple destinations (fixed amounts + rest) when a source's ETH
   exceeds the cap.

Output: `transfer_plan.csv` (one row per transfer, ordered so ERC-20s go
first and native `Send Max` goes last per `(wallet, chain)`) + `destinations`
and `groups` persisted in `config.json` for auditability and re-runs.

Re-running the wizard offers to reuse existing groups and destinations from
`config.json`, so you can tweak balances/caps without re-entering addresses.

### 3. Sign and send

```bash
# dry-run: build + estimate only, no broadcast (still asks Trezor to confirm)
node sign_and_send.js --dry-run          # or: npm run dry-run

# real run
node sign_and_send.js                    # or: npm run execute

# only process transfers >= $10k
node sign_and_send.js --skip-under=10000 # or: npm run only-big

# re-show rows you previously pressed [s]kip on
node sign_and_send.js --include-skipped
```

For each row the signer prints the tx context:

```
==============================================================================
TX [TrezorA] Hot wallet  —  chain eth-mainnet step 1
------------------------------------------------------------------------------
  From:         0xabc...  [m/44'/60'/0'/0/0]
  Source bal:   123.456 USDC  ✓ enough
  Token:        USDC   contract 0xA0b86991c...
  Amount:       123.456 USDC   ≈ $123.46
  Destination:  Family-1   →   0xdef...
  Dest balance: 42.0 USDC  (after this tx: 165.456)
==============================================================================
  [y]sign+send  [s]skip  [q]quit  >
```

- `y` → Trezor signs, script broadcasts, waits for confirmation, verifies
  the destination balance changed by exactly the expected amount.
- `s` → persist "skipped" in `execution_state.json` — won't reappear on
  future runs unless you pass `--include-skipped`.
- `q` → quit cleanly. Re-run later to continue; completed rows are skipped
  automatically.

## Safety notes

- **Destinations are double-checked.** The signer refuses to proceed if a
  `destination_address` in the CSV doesn't match `config.json`.
- **Signature recovery is verified.** After the Trezor signs, the script
  re-derives the sender from the signature and aborts if it doesn't match
  the expected source address.
- **Send Max for native ETH** uses the same fee math as the actual tx and
  keeps a buffer so the broadcast survives base-fee jumps between fetch and
  broadcast. If the node still returns `INSUFFICIENT_FUNDS`, the script
  doubles the reserve and re-signs (up to 5 times), asking you to confirm
  each retry on the device.
- **Every broadcast is logged.** `execution_log.ndjson` (one JSON per line)
  records `{timestamp, source, destination, chain, token, amount_sent,
  amount_received, tx_hash, block, gas_used}`. Both this file and
  `execution_state.json` are gitignored.

## Files

Committed:

```
plan.py               interactive wizard → transfer_plan.csv + config.json
sign_and_send.js      iterate CSV, sign on Trezor, broadcast, verify
check_balances.py     diagnostic: token balances across all sources
check_nfts.py         diagnostic: NFT holdings (rough USD estimate)
common.py             shared helpers (env, config I/O, Alchemy calls)
config.example.json   template for config.json (placeholder addrs)
.env.example          template for .env (empty)
package.json          Node deps + npm scripts (execute, dry-run, only-big)
package-lock.json     locked dep tree
```

Generated at runtime (gitignored):

```
config.json           your sources + wizard-written destinations/groups
.env                  your API key and caps
transfer_plan.csv     one row per transfer, written by plan.py
execution_state.json  completed + skipped rows, for resume
execution_log.ndjson  one JSON line per broadcast
```

## License

Unlicensed / private. Audit before trusting with real funds.
