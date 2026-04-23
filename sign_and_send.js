#!/usr/bin/env node
/**
 * Step-by-step token consolidation signer for Trezor Model One.
 *
 * Reads transfer_plan.csv, derives paths from the connected Trezor, shows each tx for
 * user approval in the terminal, signs on the Trezor device, broadcasts, waits for confirmation.
 *
 * Safety features:
 *   - Verifies destination addresses match config.json (pre-approved config).
 *   - Verifies recovered signature matches expected source address.
 *   - Persists completed tx hashes to execution_state.json (resume on crash/quit).
 *   - Appends every tx to execution_log.ndjson.
 *   - --dry-run: builds and signs but does NOT broadcast (still asks Trezor to confirm).
 *   - --skip-under=N: only process tx with USD value >= N.
 *   - Rows marked [s]kip are persisted in execution_state.json and do NOT reappear on the next run.
 *     Pass --include-skipped to show them again.
 *
 * Prerequisites:
 *   1. Trezor Suite open (it bundles the bridge; standalone Trezor Bridge was deprecated).
 *   2. Trezor Model One connected via USB, unlocked, firmware >= 1.12 (for EIP-1559).
 *   3. npm install (see package.json).
 *
 * Usage:
 *   node sign_and_send.js                    # process all pending
 *   node sign_and_send.js --skip-under=1000  # only tx >= $1k
 *   node sign_and_send.js --dry-run          # no broadcast
 *   node sign_and_send.js --include-skipped  # re-show rows previously marked skipped
 */

import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parse } from 'csv-parse/sync';
import { ethers } from 'ethers';
import 'dotenv/config';
import TrezorConnectPkg from '@trezor/connect';
const TrezorConnect = TrezorConnectPkg.default ?? TrezorConnectPkg;

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) {
  console.error('Missing ALCHEMY_API_KEY. Copy .env.example to .env and set it.');
  process.exit(1);
}

const CSV_PATH = 'transfer_plan.csv';
const CONFIG_PATH = 'config.json';
const STATE_PATH = 'execution_state.json';
const LOG_PATH = 'execution_log.ndjson';

const CHAINS = {
  'eth-mainnet':   { id: 1,     rpc: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     eip1559: true,  native: 'ETH'   },
  'base-mainnet':  { id: 8453,  rpc: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,    eip1559: true,  native: 'ETH'   },
  'arb-mainnet':   { id: 42161, rpc: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     eip1559: true,  native: 'ETH'   },
  'opt-mainnet':   { id: 10,    rpc: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     eip1559: true,  native: 'ETH'   },
  'matic-mainnet': { id: 137,   rpc: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, eip1559: true,  native: 'MATIC' },
  'bnb-mainnet':   { id: 56,    rpc: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,     eip1559: false, native: 'BNB'   },
};

const ERC20_IFACE = new ethers.Interface([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const rl = readline.createInterface({ input, output });
const ask = async (q) => (await rl.question(q)).trim().toLowerCase();
const confirm = async (q) => {
  const a = await ask(`${q} (y/n): `);
  return a === 'y' || a === 'yes';
};

function toHex(x) { return '0x' + BigInt(x).toString(16); }
function fmtUsd(n) { return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

async function loadJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}
async function saveJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

async function initTrezor() {
  await TrezorConnect.init({
    lazyLoad: false,
    manifest: { email: 'anonymous@example.com', appUrl: 'http://localhost' },
  });
}

async function discoverPaths(sourceAddrs) {
  // Try both common EVM derivation patterns used by Trezor Suite and MetaMask.
  const patterns = [];
  for (let i = 0; i < 20; i++) patterns.push(`m/44'/60'/${i}'/0/0`);
  for (let i = 0; i < 20; i++) patterns.push(`m/44'/60'/0'/0/${i}`);
  const bundle = patterns.map(path => ({ path, showOnTrezor: false }));
  const res = await TrezorConnect.ethereumGetAddress({ bundle });
  if (!res.success) throw new Error('Trezor getAddress failed: ' + (res.payload?.error || 'unknown'));
  const found = {};
  for (const e of res.payload) {
    const a = e.address.toLowerCase();
    if (sourceAddrs.includes(a)) found[a] = e.serializedPath;
  }
  return found;
}

async function getTokenDecimals(provider, tokenAddr) {
  const c = new ethers.Contract(tokenAddr, ERC20_IFACE, provider);
  return Number(await c.decimals());
}
async function getTokenBalance(provider, tokenAddr, holder) {
  const c = new ethers.Contract(tokenAddr, ERC20_IFACE, provider);
  return await c.balanceOf(holder);
}

// Compute send-max amount so (amount + gasLimit * maxFeePerGas * buffer) == balance.
// The fee formula here MUST mirror buildAndSignTx so the reserve matches the tx's actual
// upper bound. Otherwise broadcast fails with INSUFFICIENT_FUNDS (have X want Y).
async function computeSendMaxAmount({ provider, chainCfg, fromAddr, toAddr, bufferMult }) {
  const bal = await provider.getBalance(fromAddr);
  const feeData = await provider.getFeeData();
  let effectiveMaxFee;
  const baseHint = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (chainCfg.eip1559 && baseHint) {
    const maxPrio = feeData.maxPriorityFeePerGas ?? 0n;
    effectiveMaxFee = (baseHint * 2n) + maxPrio;
  } else {
    if (!feeData.gasPrice) throw new Error('no gas price from RPC');
    effectiveMaxFee = (feeData.gasPrice * 130n) / 100n;
  }
  const est = await provider.estimateGas({ from: fromAddr, to: toAddr, value: 1n });
  const gasLimit = (est * 120n) / 100n;
  const reserve = gasLimit * effectiveMaxFee * BigInt(bufferMult);
  if (bal <= reserve) {
    throw new Error(`balance < gas reserve (bal=${ethers.formatUnits(bal, 18)} ${chainCfg.native}, reserve=${ethers.formatUnits(reserve, 18)} x${bufferMult})`);
  }
  return { amount: bal - reserve, bal, reserve };
}

async function buildAndSignTx({ trezorPath, provider, chainCfg, fromAddr, toAddr, value, data }) {
  const feeData = await provider.getFeeData();
  const nonce = await provider.getTransactionCount(fromAddr, 'pending');
  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: fromAddr, to: toAddr, value, data });
    gasLimit = (est * 120n) / 100n;
  } catch (e) {
    throw new Error(`estimateGas failed: ${e.shortMessage || e.message}`);
  }

  const common = {
    to: toAddr,
    value: toHex(value),
    data: data || '0x',
    chainId: chainCfg.id,
    nonce: toHex(nonce),
    gasLimit: toHex(gasLimit),
  };

  let trezorTx, ethParams, usedFee;
  // Use EIP-1559 if the chain supports it and we have a base-fee hint (maxFeePerGas or gasPrice).
  // Priority fee can be missing on L2s like Arbitrum — default to 0.
  // maxFeePerGas = 2x base hint so the tx survives base-fee jumps between fetch and broadcast
  // (no overpayment: EIP-1559 charges actual baseFee + priority, capped at maxFeePerGas).
  const baseHint = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (chainCfg.eip1559 && baseHint) {
    const maxPrio = feeData.maxPriorityFeePerGas ?? 0n;
    const maxFee = (baseHint * 2n) + maxPrio;
    trezorTx = { ...common, maxFeePerGas: toHex(maxFee), maxPriorityFeePerGas: toHex(maxPrio) };
    ethParams = {
      type: 2, chainId: chainCfg.id, nonce,
      maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio,
      gasLimit, to: toAddr, value, data: data || '0x',
    };
    usedFee = maxFee;
  } else {
    const gp = feeData.gasPrice;
    if (!gp) throw new Error('no fee data from RPC (neither EIP-1559 nor legacy gasPrice)');
    // legacy chains (BNB): 30% bump to survive small price moves
    const bumped = (gp * 130n) / 100n;
    trezorTx = { ...common, gasPrice: toHex(bumped) };
    ethParams = {
      type: 0, chainId: chainCfg.id, nonce,
      gasPrice: bumped, gasLimit, to: toAddr, value, data: data || '0x',
    };
    usedFee = bumped;
  }

  const sig = await TrezorConnect.ethereumSignTransaction({ path: trezorPath, transaction: trezorTx });
  if (!sig.success) throw new Error('Trezor sign failed: ' + (sig.payload?.error || JSON.stringify(sig.payload)));

  const signedTx = ethers.Transaction.from({
    ...ethParams,
    signature: { v: Number(sig.payload.v), r: sig.payload.r, s: sig.payload.s },
  });

  if (signedTx.from.toLowerCase() !== fromAddr.toLowerCase()) {
    throw new Error(`signature recovered wrong sender: got ${signedTx.from}, expected ${fromAddr}`);
  }

  return { serialized: signedTx.serialized, hash: signedTx.hash, gasLimit, fee: usedFee };
}

function rowKey(r) {
  // Stable across plan regenerations: source + chain + token + destination.
  // step is NOT included — it can shift if prices change the USD-desc sort in plan.py.
  return `${r.source_address.toLowerCase()}|${r.chain}|${r.token_address.toLowerCase()}|${r.destination}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includeSkipped = args.includes('--include-skipped');
  const skipUnder = Number(args.find(a => a.startsWith('--skip-under='))?.split('=')[1] || 0);

  const config = await loadJson(CONFIG_PATH);
  const destinations = config.destinations;
  const rows = parse(await fs.readFile(CSV_PATH, 'utf8'), { columns: true, skip_empty_lines: true });

  // Sanity check: CSV destinations must match config.json.
  for (const r of rows) {
    const expected = destinations[r.destination];
    if (!expected) throw new Error(`CSV row has unknown destination label "${r.destination}"`);
    if (expected.toLowerCase() !== r.destination_address.toLowerCase())
      throw new Error(`CSV destination_address mismatch for ${r.destination}: CSV=${r.destination_address} config=${expected}`);
  }
  console.log(`Loaded ${rows.length} rows from CSV. Destinations verified against config.json ✓`);
  if (dryRun) console.log('>>> DRY RUN <<<  (signing but NOT broadcasting)');
  if (skipUnder) console.log(`Filter: only tx >= ${fmtUsd(skipUnder)}`);

  const state = await loadJson(STATE_PATH, { completed: {}, paths: {}, skipped: {} });
  if (!state.skipped) state.skipped = {}; // back-compat with state files written before skipped existed
  const skippedCount = Object.keys(state.skipped).length;
  console.log(`Previous state: ${Object.keys(state.completed).length} completed, ${skippedCount} skipped${includeSkipped && skippedCount ? ' (re-showing because --include-skipped)' : ''}.`);

  if (!dryRun) {
    console.log('\nInitializing Trezor Connect... (make sure Trezor Suite is open — it bundles the bridge — and the Trezor is plugged in and unlocked)');
    await initTrezor();

    const sourceAddrs = [...new Set(rows.map(r => r.source_address.toLowerCase()))];
    console.log('\nDiscovering derivation paths on the connected Trezor...');
    const discovered = await discoverPaths(sourceAddrs);
    for (const [a, p] of Object.entries(discovered)) state.paths[a] = p;
    await saveJson(STATE_PATH, state);

    const coveredNow = Object.keys(discovered);
    console.log(`  this Trezor covers ${coveredNow.length} source wallets:`);
    for (const a of coveredNow) {
      const label = rows.find(r => r.source_address.toLowerCase() === a)?.source_label || '?';
      console.log(`    ${a}  [${discovered[a]}]  ${label}`);
    }
    const notCovered = sourceAddrs.filter(a => !state.paths[a]);
    if (notCovered.length) {
      console.log(`  missing ${notCovered.length} (on the OTHER Trezor):`);
      for (const a of notCovered) {
        const label = rows.find(r => r.source_address.toLowerCase() === a)?.source_label || '?';
        console.log(`    ${a}  ${label}`);
      }
    }
  } else {
    console.log('\n[DRY-RUN] no Trezor: showing ALL source wallets from the CSV');
  }

  let pending = rows
    .filter(r => dryRun || state.paths[r.source_address.toLowerCase()])
    .filter(r => !state.completed[rowKey(r)])
    .filter(r => includeSkipped || !state.skipped[rowKey(r)])
    .filter(r => !skipUnder || Number(r.amount_usd) >= skipUnder);

  // Execution order: process one source wallet end-to-end before moving to the next.
  //   1) trezor alphabetical, then source label (case-insensitive) → groups wallet by wallet
  //   2) within a wallet, by chain alphabetical
  //   3) within (wallet, chain): ERC-20 first sorted by USD asc (small shitcoins first),
  //      then native respecting CSV step order (fixed before Send Max).
  pending.sort((a, b) => {
    const t = a.trezor.localeCompare(b.trezor);
    if (t) return t;
    const s = a.source_label.toLowerCase().localeCompare(b.source_label.toLowerCase());
    if (s) return s;
    const c = a.chain.localeCompare(b.chain);
    if (c) return c;
    const aN = a.token_address === 'NATIVE';
    const bN = b.token_address === 'NATIVE';
    if (aN !== bN) return aN ? 1 : -1;
    if (!aN) return Number(a.amount_usd) - Number(b.amount_usd);
    return Number(a.step) - Number(b.step);
  });

  const pendingUsd = pending.reduce((s, r) => s + Number(r.amount_usd), 0);
  console.log(`\n${pending.length} tx pending for this Trezor  (≈ ${fmtUsd(pendingUsd)})`);
  if (!pending.length) { await TrezorConnect.dispose(); rl.close(); return; }

  if (!(await confirm('\nStart?'))) { await TrezorConnect.dispose(); rl.close(); return; }

  const providers = {};
  const getProvider = (name) => providers[name] || (providers[name] = new ethers.JsonRpcProvider(CHAINS[name].rpc));

  for (const row of pending) {
    const chainCfg = CHAINS[row.chain];
    if (!chainCfg) { console.log(`  ! unknown chain ${row.chain}, skip`); continue; }
    const provider = getProvider(row.chain);
    const trezorPath = state.paths[row.source_address.toLowerCase()] || (dryRun ? '[would derive from Trezor]' : null);
    const fromAddr = row.source_address;
    const isNative = row.token_address === 'NATIVE';
    const noteLower = (row.note || '').toLowerCase();
    const isFixedNative = isNative && noteLower.includes('fixed');
    const isRestNative = isNative && (noteLower.includes('rest') || noteLower.includes('send max'));

    let amount, decimals, toAddr, data;

    try {
      if (isNative) {
        decimals = 18;
        toAddr = row.destination_address;
        data = '0x';
        const bal = await provider.getBalance(fromAddr);
        if (isFixedNative) {
          amount = ethers.parseUnits(row.amount, 18);
          if (amount > bal) throw new Error(`balance insufficient: ${ethers.formatUnits(bal, 18)} < ${row.amount}`);
        } else {
          // Send Max: bal - (gasLimit * maxFeePerGas) with buffer.
          const r = await computeSendMaxAmount({ provider, chainCfg, fromAddr, toAddr, bufferMult: 1 });
          amount = r.amount;
        }
      } else {
        decimals = await getTokenDecimals(provider, row.token_address).catch(() => Number(row.amount).toString().includes('.') ? 18 : 0);
        const bal = await getTokenBalance(provider, row.token_address, fromAddr);
        if (bal === 0n) { console.log(`  ! ${row.token_symbol} balance=0 on ${fromAddr}, skip`); continue; }
        amount = bal;
        toAddr = row.token_address;
        data = ERC20_IFACE.encodeFunctionData('transfer', [row.destination_address, amount]);
      }
    } catch (e) {
      console.log(`\n  ! preparing tx: ${e.message}`);
      const keepGoing = await confirm('  Continue with the next one?');
      if (!keepGoing) break;
      continue;
    }

    let amountStr = ethers.formatUnits(amount, decimals);
    const usdEst = Number(amountStr) * Number(row.usd_price);

    // pre-check balances (source + destination) to confirm viability
    const srcBal = isNative
      ? await provider.getBalance(fromAddr)
      : await getTokenBalance(provider, row.token_address, fromAddr);
    const dstBalPre = isNative
      ? await provider.getBalance(row.destination_address)
      : await getTokenBalance(provider, row.token_address, row.destination_address);
    const srcBalStr = ethers.formatUnits(srcBal, decimals);
    const dstBalPreStr = ethers.formatUnits(dstBalPre, decimals);
    const dstBalAfter = dstBalPre + amount;
    const dstBalAfterStr = ethers.formatUnits(dstBalAfter, decimals);
    const enough = srcBal >= amount;

    console.log('\n' + '='.repeat(78));
    console.log(`TX [${row.trezor}] ${row.source_label}  —  chain ${row.chain} step ${row.step}`);
    console.log('-'.repeat(78));
    console.log(`  From:         ${fromAddr}   [${trezorPath}]`);
    console.log(`  Source bal:   ${srcBalStr} ${row.token_symbol}  ${enough ? '✓ enough' : '✗ INSUFFICIENT'}`);
    console.log(`  Token:        ${row.token_symbol}${isNative ? ' (native)' : `   contract ${row.token_address}`}`);
    console.log(`  Amount:       ${amountStr} ${row.token_symbol}   ≈ ${fmtUsd(usdEst)}`);
    console.log(`  Destination:  ${row.destination}   →   ${row.destination_address}`);
    console.log(`  Dest balance: ${dstBalPreStr} ${row.token_symbol}  (after this tx: ${dstBalAfterStr})`);
    if (row.note) console.log(`  Note:         ${row.note}`);
    console.log('='.repeat(78));

    const choice = await ask('  [y]sign+send  [s]skip  [q]quit  > ');
    if (choice === 'q' || choice === 'quit') break;
    if (choice === 's' || choice === 'skip') {
      state.skipped[rowKey(row)] = { ts: new Date().toISOString() };
      await saveJson(STATE_PATH, state);
      console.log('  skipped (persisted — will not reappear; pass --include-skipped to show it again)');
      continue;
    }
    if (choice !== 'y' && choice !== 'yes') { console.log('  cancelled (not y, not s, not q)'); continue; }

    try {
      if (dryRun) {
        // Simulate without touching the Trezor: estimate gas + fees and print.
        const feeData = await provider.getFeeData();
        const nonce = await provider.getTransactionCount(fromAddr, 'pending');
        let gasLimitStr = '?';
        try {
          const est = await provider.estimateGas({ from: fromAddr, to: toAddr, value: isNative ? amount : 0n, data });
          gasLimitStr = ((est * 120n) / 100n).toString();
        } catch (e) {
          gasLimitStr = `estimate failed: ${e.shortMessage || e.message}`;
        }
        const canEip1559Here = chainCfg.eip1559 && feeData.maxFeePerGas && feeData.maxPriorityFeePerGas;
        const feeGwei = canEip1559Here
          ? `maxFee=${ethers.formatUnits(feeData.maxFeePerGas, 'gwei')} gwei, tip=${ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')} gwei`
          : `gasPrice=${ethers.formatUnits(feeData.gasPrice || 0n, 'gwei')} gwei (legacy fallback)`;
        console.log(`  [DRY-RUN] nonce=${nonce}  gasLimit=${gasLimitStr}  ${feeGwei}  (no signature, no broadcast)`);
        if (enough) {
          console.log(`  [DRY-RUN] ✓ if executed: destination would receive ${amountStr} ${row.token_symbol}  (new balance: ${dstBalAfterStr})`);
        } else {
          console.log(`  [DRY-RUN] ✗ would NOT execute: source balance (${srcBalStr}) < amount (${amountStr})`);
        }
        continue;
      }

      // pre-balance at destination (for post-tx verification)
      const preDestBal = isNative
        ? await provider.getBalance(row.destination_address)
        : await getTokenBalance(provider, row.token_address, row.destination_address);

      // Retry loop: only re-enters on INSUFFICIENT_FUNDS for send-max native.
      // Each attempt doubles the gas reserve and re-signs on the Trezor (user confirms again).
      let signed, txResp, receipt;
      const maxAttempts = isRestNative ? 5 : 1;
      let bufferMult = 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (attempt > 1) {
            bufferMult *= 2;
            const r = await computeSendMaxAmount({ provider, chainCfg, fromAddr, toAddr, bufferMult });
            amount = r.amount;
            amountStr = ethers.formatUnits(amount, decimals);
            console.log(`  ↻ retry ${attempt}/${maxAttempts}: buffer x${bufferMult} → amount ${amountStr} ${row.token_symbol}  (reserve ${ethers.formatUnits(r.reserve, 18)})`);
          }
          console.log(attempt === 1
            ? '  → building + asking Trezor for signature (confirm on device)...'
            : '  → re-sign on Trezor with the new amount...');
          signed = await buildAndSignTx({
            trezorPath, provider, chainCfg, fromAddr, toAddr, value: isNative ? amount : 0n, data,
          });
          console.log(`    signed. pre-broadcast hash: ${signed.hash}`);

          console.log('  → broadcasting...');
          txResp = await provider.broadcastTransaction(signed.serialized);
          console.log(`    sent: ${txResp.hash}. waiting for confirmation...`);
          receipt = await txResp.wait();
          if (receipt.status !== 1) throw new Error(`tx reverted, status=${receipt.status}`);
          break;
        } catch (e) {
          const msg = e.message || '';
          const isInsufficient = e.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(msg);
          if (isRestNative && isInsufficient && attempt < maxAttempts) {
            console.log(`  ✗ insufficient funds on broadcast — retrying with larger gas reserve`);
            continue;
          }
          throw e;
        }
      }
      console.log(`  ✓ confirmed in block ${receipt.blockNumber}  gas used: ${receipt.gasUsed}`);

      // verify destination received the funds
      const postDestBal = isNative
        ? await provider.getBalance(row.destination_address)
        : await getTokenBalance(provider, row.token_address, row.destination_address);
      const received = postDestBal - preDestBal;
      const receivedStr = ethers.formatUnits(received, decimals);
      const expectedStr = ethers.formatUnits(amount, decimals);
      if (received === amount) {
        console.log(`  ✓ destination received exactly ${receivedStr} ${row.token_symbol} (match)`);
      } else if (received < amount) {
        const lost = ethers.formatUnits(amount - received, decimals);
        console.log(`  ⚠ destination received ${receivedStr} ${row.token_symbol}; expected ${expectedStr} (missing ${lost} — possible token fee/tax)`);
        const goOn = await confirm('  Continue anyway?');
        if (!goOn) break;
      } else {
        console.log(`  ✓ destination received ${receivedStr} ${row.token_symbol} (≥ expected ${expectedStr} — parallel deposits into destination)`);
      }

      const logEntry = {
        ts: new Date().toISOString(),
        key: rowKey(row),
        trezor: row.trezor,
        source_label: row.source_label,
        source_address: fromAddr,
        destination: row.destination,
        destination_address: row.destination_address,
        chain: row.chain,
        token_symbol: row.token_symbol,
        amount_sent: amountStr,
        amount_received: receivedStr,
        amount_usd_est: usdEst,
        tx_hash: receipt.hash,
        block: receipt.blockNumber,
        gas_used: receipt.gasUsed.toString(),
      };
      await fs.appendFile(LOG_PATH, JSON.stringify(logEntry) + '\n');
      state.completed[rowKey(row)] = { hash: receipt.hash, ts: logEntry.ts };
      await saveJson(STATE_PATH, state);
    } catch (e) {
      console.error(`  ✗ error: ${e.message}`);
      const keepGoing = await confirm('  Continue with the next one?');
      if (!keepGoing) break;
    }
  }

  console.log(`\nDone. Total completed so far: ${Object.keys(state.completed).length}`);
  if (!dryRun) await TrezorConnect.dispose();
  rl.close();
}

process.on('SIGINT', async () => {
  console.log('\n\nInterrupted — closing Trezor Connect and exiting...');
  try { await TrezorConnect.dispose(); } catch {}
  rl.close();
  process.exit(130);
});

main().catch(async (e) => {
  console.error('\nFATAL:', e.stack || e.message);
  try { await TrezorConnect.dispose(); } catch {}
  rl.close();
  process.exit(1);
});
