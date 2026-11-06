---
name: ika-solana-pre-alpha
version: 1.0.0
description: Guide for building on the Ika Solana devnet pre-alpha, a mock ika network. Use when creating dWallets or signing from a TypeScript app on Solana devnet, when writing a Solana program that controls a dWallet through the ika CPI crates, or when a task names @ika.xyz/sdk-solana, withMockCryptography, @ika.xyz/sdk-core/mock, ika-dwallet-pinocchio, ika-dwallet-anchor, ika-dwallet-native, DWalletContext, issue_signature_voucher, or the program CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT.
metadata:
  openclaw:
    requires:
      bins:
        - node
    emoji: "🧪"
    homepage: "https://ika.xyz"
    tags:
      - solana
      - typescript
      - sdk
      - dwallet
      - mock
      - pre-alpha
---

# Ika on Solana: the devnet pre-alpha

A dWallet is a signing key that a Solana account controls. Its owner decides which messages it
signs, and the ika network produces the signatures. When the owner is a Solana program, the
program's rules decide.

## The pre-alpha is a mock. Tell the user.

The Solana devnet pre-alpha does not run the real ika network. One backend, the mock, stands in for
every validator.

- There is no MPC. The mock holds an ordinary private key for every dWallet and signs alone.
- It is not secure. The mock can sign any message with any dWallet. Never put real funds on a
  pre-alpha dWallet, and say so to the user when you build something that holds value.
- No private key is ever sent to the mock. An imported key is not read: the mock makes a new key,
  so the imported dWallet has a different public key and address.
- Everything is wiped from time to time. A wipe can change the program id and the network key.

Everything else is real: the Solana program, the transactions, and the SDK's calls and checks. An
app moves to the real network by dropping mock mode and naming the real network.

## Addresses

| What | Value |
| --- | --- |
| Solana cluster | devnet, `https://api.devnet.solana.com` (rate-limited: prefer the user's own RPC) |
| ika program | `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT` |
| ika network, gRPC-Web, for TypeScript | `https://solana-alpha-dev-1.ika-network.net` |
| Network key | `fe8a6482521cc4bae052c55cd5b3c92d05c8749bcc2c584046de3efb077d65ed` |
| Chain number | `1` |
| Network value | `3` |
| IKA mint | `2hncrdGVjmRtDFQ4bsNkoJd5XuR2v1DKiUX7aSRUA3H1` |
| Treasury vault | `476J1DYngyTv6uqQ7pooJ6Mv1rxsZNdbd4h6A2vmRNFc` |

The program's dWallet coordinator account records the chain number, network value, IKA mint and
treasury vault. If a value here stops working, read it from that account. Never take these values
from an answer of the ika network.

## Rules that prevent the common failures

1. **Mock mode is required.** TypeScript: wrap the client options in `withMockCryptography` from
   `@ika.xyz/sdk-core/mock`. Without it the SDK refuses
   the network with "mock values need the SDK's mock feature". Mock mode needs a custom network.
2. **Use gRPC-Web.** A plain gRPC client on port 443 gets HTTP 400.
   In Node, pass a `DWalletGrpcClient` from `@ika.xyz/sdk-core/web`, not a URL string.
3. **Wait for `finalized`.** The network reads Solana at finalized commitment. Send the next request
   only after the transaction it depends on is finalized.
4. **One gas deposit per root seed.** Requests are charged to the request key's gas deposit, and the
   request key comes from the root seed. A new root seed needs a new `createGasDeposit()`. The mock
   charges nothing, so an empty deposit is enough, but it must exist.
5. **Register the encryption key once per curve**, in a transaction of its own (it takes 876 of the
   1,232 bytes).
6. **Accept the share.** After `requestDWalletDKG`, send `acceptEncryptedUserShare` and wait with
   `waitForDWallet`. A dWallet is unusable before that.
7. **A voucher's signing key is the user's request key**, not the wallet:
   `ikaClient.getRequestPublicKey(keys)`.
8. **ECDSA signatures are 65 bytes**: the recovery byte, then `r` and `s`. Use `signature.slice(1)`
   with a 64-byte verifier. Ed25519 signatures are 64 bytes.
9. **Programs build with the network feature.** `cargo build-sbf --tools-version v1.54 --arch v3 --
   --features devnet-pre-alpha`. A program built without it refuses every devnet dWallet.
10. **Devnet SOL comes from https://faucet.solana.com.** The devnet RPC faucet is closed, so
    `requestAirdrop` fails with 410. Never spend a wallet the user did not give you for this.

## The shortest flow

```ts
import { DWalletGrpcClient } from '@ika.xyz/sdk-core/web';
import { withMockCryptography } from '@ika.xyz/sdk-core/mock';
import {
	Curve, Hash, IkaClient, IkaTransaction, SignatureAlgorithm, UserShareEncryptionKeys,
} from '@ika.xyz/sdk-solana/web3';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const ikaClient = new IkaClient(
	withMockCryptography({
		connection,
		grpc: new DWalletGrpcClient('https://solana-alpha-dev-1.ika-network.net'),
		config: {
			network: { custom: { networkPublicKeys: [Uint8Array.from(Buffer.from('fe8a6482521cc4bae052c55cd5b3c92d05c8749bcc2c584046de3efb077d65ed', 'hex'))] } },
			programId: new PublicKey('CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT'),
			chainNumber: 1,
			networkValue: 3,
		},
	}),
);

const keys = await UserShareEncryptionKeys.fromRootSeedKey(rootSeed, Curve.ED25519);

async function send(build: (ikaTx: IkaTransaction) => unknown) {
	const transaction = new Transaction();
	const ikaTx = new IkaTransaction({ ikaClient, transaction, owner: wallet.publicKey, userShareEncryptionKeys: keys });
	await build(ikaTx);
	transaction.feePayer = wallet.publicKey;
	transaction.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
	transaction.sign(wallet, ...ikaTx.signers); // voucher keypairs sign their own creation
	const sig = await connection.sendRawTransaction(transaction.serialize());
	await connection.confirmTransaction(sig, 'finalized');
}

await send((tx) => tx.registerEncryptionKey({ curve: Curve.ED25519 }));
await send((tx) => tx.createGasDeposit());
const { dWallet } = await ikaClient.requestDWalletDKG({ curve: Curve.ED25519, userShareEncryptionKeys: keys, owner: wallet.publicKey });
await send((tx) => tx.acceptEncryptedUserShare({ dWallet }));
await ikaClient.waitForDWallet(dWallet);

const scheme = { signatureAlgorithm: SignatureAlgorithm.EdDSA, hashScheme: Hash.SHA512 };
let voucher!: PublicKey;
await send(async (tx) => { voucher = await tx.approveMessage({ dWallet, message, ...scheme }); });
const signature = await ikaClient.requestSign({ dWallet, signatureVoucherId: voucher, message, ...scheme, userShareEncryptionKeys: keys });
```

## References (load on demand)

- `references/typescript.md`: installing, the client options, every `IkaClient` call, kit, browsers,
  an app paying for its users, and the errors an app handles.
- `references/programs.md`: a Solana program that owns dWallets: the CPI crates, the network
  feature, `issue_signature_voucher`, the rules a program must follow, and testing.

The full guide is the book in `docs/` of https://github.com/dwallet-labs/ika-pre-alpha. The
TypeScript SDK is in `sdk/` there, and is not on npm yet: build it from that repository. The working
examples are `examples/voting` and `examples/multisig`.
