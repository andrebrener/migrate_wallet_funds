/**
 * Ledger signer adapter.
 *
 * Interface (shared with trezor.js):
 *   createLedgerSigner() → {
 *     name,
 *     discoverPaths(sourceAddrs)      → { [lowercaseAddr]: "m/44'/60'/.../..." }
 *     signTx({ path, ethParams })     → { v, r, s }   // v is number, r/s are 0x-hex
 *     dispose()
 *   }
 *
 * Differences vs Trezor:
 *   - No batch address lookup: we iterate one path at a time over USB HID.
 *     40 patterns × ~100ms per call → roughly 4s on first run.
 *   - Ledger signs the RLP-serialized *unsigned* tx, not a structured object.
 *     We build the unsigned tx with ethers and hand the hex to the device.
 *   - For EIP-1559 (type 2) the returned v is yParity (0 or 1). ethers.js accepts that.
 *   - For legacy (type 0) v is EIP-155 encoded (chainId*2 + {35,36}). ethers.js accepts that too.
 *
 * Prerequisites:
 *   - Ledger connected via USB, unlocked, Ethereum app open.
 *   - Ethereum app firmware supporting EIP-1559 (≥ 1.9.x on Nano S / 1.9.x on Nano X).
 *   - If `ledgerService.resolveTransaction` fails (offline / unsupported token),
 *     the device will fall back to blind signing — enable it in app settings if prompted.
 */

import TransportNodeHidPkg from '@ledgerhq/hw-transport-node-hid';
import EthPkg, { ledgerService as ledgerServicePkg } from '@ledgerhq/hw-app-eth';
import { ethers } from 'ethers';

const TransportNodeHid = TransportNodeHidPkg.default ?? TransportNodeHidPkg;
const Eth = EthPkg.default ?? EthPkg;
const ledgerService = ledgerServicePkg ?? EthPkg.ledgerService;

// Ledger derivation paths are written without the leading "m/".
const stripM = (p) => p.replace(/^m\//, '');

export async function createLedgerSigner() {
  const transport = await TransportNodeHid.create();
  const eth = new Eth(transport);

  return {
    name: 'ledger',

    async discoverPaths(sourceAddrs) {
      const patterns = [];
      for (let i = 0; i < 20; i++) patterns.push(`m/44'/60'/${i}'/0/0`);
      for (let i = 0; i < 20; i++) patterns.push(`m/44'/60'/0'/0/${i}`);
      const found = {};
      for (const path of patterns) {
        let res;
        try {
          res = await eth.getAddress(stripM(path), false);
        } catch (e) {
          throw new Error(
            `Ledger getAddress failed on ${path}: ${e.message}. ` +
            `Make sure the Ethereum app is open on the device.`,
          );
        }
        const a = res.address.toLowerCase();
        if (sourceAddrs.includes(a)) found[a] = path;
      }
      return found;
    },

    async signTx({ path, ethParams }) {
      // Build the unsigned tx with ethers so the RLP/EIP-2718 envelope is correct
      // for both legacy (type 0) and EIP-1559 (type 2) txs.
      const unsigned0x = ethers.Transaction.from(ethParams).unsignedSerialized;
      const unsigned = unsigned0x.startsWith('0x') ? unsigned0x.slice(2) : unsigned0x;

      // Best-effort clearsigning metadata (pretty token display on-device).
      // If this fails (offline, unsupported token) the device falls back to blind signing.
      let resolution = null;
      try {
        resolution = await ledgerService.resolveTransaction(unsigned, {}, { erc20: true, externalPlugins: true });
      } catch {}

      const sig = await eth.signTransaction(stripM(path), unsigned, resolution);
      return {
        v: parseInt(sig.v, 16),
        r: '0x' + sig.r,
        s: '0x' + sig.s,
      };
    },

    async dispose() {
      try { await transport.close(); } catch {}
    },
  };
}
