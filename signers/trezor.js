/**
 * Trezor signer adapter.
 *
 * Interface (shared with ledger.js):
 *   createTrezorSigner() → {
 *     name,
 *     discoverPaths(sourceAddrs)      → { [lowercaseAddr]: "m/44'/60'/.../..." }
 *     signTx({ path, ethParams })     → { v, r, s }   // v is number, r/s are 0x-hex
 *     dispose()
 *   }
 *
 * ethParams is the ethers.js-style tx params object — same shape for every signer.
 * The adapter is responsible for translating it to its device-native format.
 *
 * Prerequisites:
 *   - Trezor Suite open (bundles the bridge; standalone Trezor Bridge was deprecated).
 *   - Trezor Model One/T connected, unlocked, firmware ≥ 1.12 for EIP-1559.
 */

import TrezorConnectPkg from '@trezor/connect';
const TrezorConnect = TrezorConnectPkg.default ?? TrezorConnectPkg;

const toHex = (x) => '0x' + BigInt(x).toString(16);

export async function createTrezorSigner() {
  await TrezorConnect.init({
    lazyLoad: false,
    manifest: { email: 'anonymous@example.com', appUrl: 'http://localhost' },
  });

  return {
    name: 'trezor',

    async discoverPaths(sourceAddrs) {
      // Try both common EVM derivation patterns used by Trezor Suite and MetaMask.
      const patterns = [];
      for (let i = 0; i < 20; i++) patterns.push(`m/44'/60'/${i}'/0/0`);
      for (let i = 0; i < 20; i++) patterns.push(`m/44'/60'/0'/0/${i}`);
      const bundle = patterns.map((path) => ({ path, showOnTrezor: false }));
      const res = await TrezorConnect.ethereumGetAddress({ bundle });
      if (!res.success) throw new Error('Trezor getAddress failed: ' + (res.payload?.error || 'unknown'));
      const found = {};
      for (const e of res.payload) {
        const a = e.address.toLowerCase();
        if (sourceAddrs.includes(a)) found[a] = e.serializedPath;
      }
      return found;
    },

    async signTx({ path, ethParams }) {
      const common = {
        to: ethParams.to,
        value: toHex(ethParams.value),
        data: ethParams.data || '0x',
        chainId: ethParams.chainId,
        nonce: toHex(ethParams.nonce),
        gasLimit: toHex(ethParams.gasLimit),
      };
      const transaction = ethParams.type === 2
        ? {
            ...common,
            maxFeePerGas: toHex(ethParams.maxFeePerGas),
            maxPriorityFeePerGas: toHex(ethParams.maxPriorityFeePerGas),
          }
        : { ...common, gasPrice: toHex(ethParams.gasPrice) };

      const sig = await TrezorConnect.ethereumSignTransaction({ path, transaction });
      if (!sig.success) throw new Error('Trezor sign failed: ' + (sig.payload?.error || JSON.stringify(sig.payload)));
      return { v: Number(sig.payload.v), r: sig.payload.r, s: sig.payload.s };
    },

    async dispose() {
      try { await TrezorConnect.dispose(); } catch {}
    },
  };
}
