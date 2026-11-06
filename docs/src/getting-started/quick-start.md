# Quick Start

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This page takes a TypeScript app from nothing to a signature on the devnet pre-alpha. The app
creates an Ed25519 dWallet, approves one message, has the network sign it, and checks the signature.
Then it shows where a Solana program takes over the approval.

You need Node.js 22.12 or later, the packages from [Installation](./installation.md), and a devnet
keypair with about 0.1 SOL. Get the SOL from <https://faucet.solana.com>.

## 1. Create the client

The client needs two connections: one to Solana, to send transactions and read accounts, and one to
the ika network, to send requests. The values come from [the devnet pre-alpha](./devnet.md).

```ts
import { DWalletGrpcClient } from '@ika.xyz/sdk-core/web';
import { withMockCryptography } from '@ika.xyz/sdk-core/mock';
import {
	Curve,
	Hash,
	IkaClient,
	IkaTransaction,
	SignatureAlgorithm,
	UserShareEncryptionKeys,
} from '@ika.xyz/sdk-solana/web3';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const programId = new PublicKey('CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT');
const networkKey = Uint8Array.from(
	Buffer.from('fe8a6482521cc4bae052c55cd5b3c92d05c8749bcc2c584046de3efb077d65ed', 'hex'),
);

const ikaClient = new IkaClient(
	withMockCryptography({
		connection,
		grpc: new DWalletGrpcClient('https://solana-alpha-dev-1.ika-network.net'),
		config: {
			network: { custom: { networkPublicKeys: [networkKey] } },
			programId,
			chainNumber: 1,
			networkValue: 3,
		},
	}),
);
```

`withMockCryptography` puts the client in mock mode, which the pre-alpha needs. Drop it, and name the
real network, to move the same app to the real network.

## 2. Make the user's keys

Every key of a user comes from one root seed of 32 random bytes. Keep the seed as a secret: a user who
loses it loses the shares of their dWallets.

```ts
const wallet = Keypair.fromSecretKey(/* your devnet keypair */);
const rootSeed = crypto.getRandomValues(new Uint8Array(32));
const keys = await UserShareEncryptionKeys.fromRootSeedKey(rootSeed, Curve.ED25519);
```

`wallet` is the user's Solana wallet. It pays for transactions and owns the new dWallet. `keys` holds
the user's encryption key, which the user's share is encrypted to, and the request key, which signs
every request to the network.

## 3. Register the encryption key and open a gas deposit

Both are Solana transactions the wallet signs, once per root seed. The registration goes in a
transaction of its own, because it carries the whole encryption key.

```ts
async function send(build: (ikaTx: IkaTransaction) => unknown): Promise<void> {
	const transaction = new Transaction();
	const ikaTx = new IkaTransaction({
		ikaClient,
		transaction,
		owner: wallet.publicKey,
		userShareEncryptionKeys: keys,
	});
	await build(ikaTx);
	transaction.feePayer = wallet.publicKey;
	transaction.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
	transaction.sign(wallet, ...ikaTx.signers);
	const signature = await connection.sendRawTransaction(transaction.serialize());
	// The network reads Solana at finalized commitment, so wait for it.
	await connection.confirmTransaction(signature, 'finalized');
}

await send((ikaTx) => ikaTx.registerEncryptionKey({ curve: Curve.ED25519 }));
await send((ikaTx) => ikaTx.createGasDeposit());
```

Every request is charged to the gas deposit of the key that signs it. The mock charges nothing, so an
empty deposit is enough. On the real network, fund it with `topUpGasDeposit`.

## 4. Create the dWallet

```ts
const { dWallet } = await ikaClient.requestDWalletDKG({
	curve: Curve.ED25519,
	userShareEncryptionKeys: keys,
	owner: wallet.publicKey,
});
await send((ikaTx) => ikaTx.acceptEncryptedUserShare({ dWallet }));
const address = await ikaClient.waitForDWallet(dWallet);
```

`requestDWalletDKG` asks the network for a new dWallet and checks the network's answer. The network
writes the `DWallet` account on Solana and leaves the user's share waiting there. The user accepts
the share in a Solana transaction, and only then can the dWallet sign. `waitForDWallet` returns the
dWallet account's address once Solana shows the acceptance.

## 5. Approve a message and sign it

```ts
const message = new TextEncoder().encode('hello from the pre-alpha');
const scheme = { signatureAlgorithm: SignatureAlgorithm.EdDSA, hashScheme: Hash.SHA512 };

let signatureVoucher!: PublicKey;
await send(async (ikaTx) => {
	signatureVoucher = await ikaTx.approveMessage({ dWallet, message, ...scheme });
});

const signature = await ikaClient.requestSign({
	dWallet,
	signatureVoucherId: signatureVoucher,
	message,
	...scheme,
	userShareEncryptionKeys: keys,
});

console.log('verifies:', ed25519.verify(signature, message, dWallet.publicKey));
```

`approveMessage` adds an instruction that creates a signature voucher: an account that allows one
signature of this message, with this dWallet. The voucher lives at a fresh address that signs its own
creation, which is why `send` signs with `ikaTx.signers` too.

`requestSign` reads the voucher first, and refuses before sending anything if the voucher is for
another dWallet, message or scheme. It takes a presign from the network's pool, sends the sign
request, and checks the signature against the dWallet's public key. The network also writes the
signature into the voucher account.

## 6. Hand the approval to a program

Above, the user's wallet owns the dWallet, so the wallet approves messages. To let a program decide
instead, transfer the dWallet to the program's CPI authority. That is the address derived from the
seed `__ika_cpi_authority` under your program's id. Only your program can sign for it.

```ts
const [cpiAuthority] = PublicKey.findProgramAddressSync(
	[Buffer.from('__ika_cpi_authority')],
	yourProgramId,
);
await send((ikaTx) => ikaTx.transferDWallet({ dWallet, newOwner: cpiAuthority }));
```

Set up your program's own record of who may use the dWallet before this transfer, while the wallet
still owns it. After the transfer, only your program can act on the dWallet.

From then on, your program creates the voucher through a CPI when its conditions hold:

```rust
ctx.issue_signature_voucher(
    coordinator,             // the ika program's DWalletCoordinator account
    signature_voucher,       // a fresh writable address that signs its own creation
    dwallet,                 // the dWallet account
    payer,                   // pays the voucher's rent
    system_program,
    message_digest,          // keccak256 of the message
    message_metadata_digest, // keccak256 of the metadata, or all zeros if there is none
    signature_scheme,        // a DWalletSignatureScheme value, for example 5 for EdDSA with SHA-512
    None,                    // the voucher's owner: None makes it your program's CPI authority
    Some(user_pubkey),       // the request key allowed to send the sign request
    Some(&voucher_seeds),    // the voucher's seeds, when it is your program's PDA
)?;
```

The app then calls `requestSign` with that voucher's address, as in step 5.

The ika program checks only that your program owns the dWallet. Which dWallet gets a voucher, and who
may ask for one, is your program's decision. Read [Integrator Invariants](../on-chain/integrator-invariants.md)
before you ship, and follow the [voting tutorial](../tutorial/overview.md) for a whole program.
