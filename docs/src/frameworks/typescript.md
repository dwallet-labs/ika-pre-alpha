# TypeScript SDK

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The TypeScript SDK creates dWallets, asks the ika network for signatures, and builds the Solana
instructions that go with them. It runs in Node and in a browser.

It comes as two packages:

- `@ika.xyz/sdk-core` is the part every chain shares: the requests to the network, the user's keys,
  the checks of the network's answers, and the user's half of each protocol step.
- `@ika.xyz/sdk-solana` is the Solana part: the program's addresses and instructions, the readers
  for its accounts, and the `IkaClient` and `IkaTransaction` classes an app uses.

`@ika.xyz/sdk-solana` has two entry points with the same classes. Import
`@ika.xyz/sdk-solana/web3` if your app uses `@solana/web3.js`, or `@ika.xyz/sdk-solana/kit` if it
uses `@solana/kit`. The examples below use web3.js.

## The three classes

- **`UserShareEncryptionKeys`** holds every key of one user, derived from one root seed.
- **`IkaTransaction`** adds the ika program's instructions to a Solana transaction that the user's
  wallet signs.
- **`IkaClient`** sends requests to the ika network and reads the program's accounts on Solana.

Requests to the network do not go through Solana. The SDK sends them to the network directly, signed
by the user's request key, which comes from the root seed. So the wallet never signs request bytes.
It signs only Solana transactions: the encryption key's registration, the gas deposit, the share's
acceptance and the vouchers that approve messages.

## Creating the client

```ts
import { DWalletGrpcClient } from '@ika.xyz/sdk-core/web';
import { IkaClient } from '@ika.xyz/sdk-solana/web3';

const ikaClient = new IkaClient({
	connection, // a @solana/web3.js Connection
	grpc, // the ika network: a URL, or a DWalletGrpcClient
	config: { network, programId },
});
```

`config.network` names the ika network. It is `'mainnet'`, `'testnet'`, or for any other network
`{ custom: { networkPublicKeys } }`. A custom network also needs `chainNumber` and `networkValue` on
`config`. Take these values from the network's operator or from the program's coordinator account,
never from an answer of the ika network. The SDK checks every answer against the network keys, and
the user signs the chain number and the network value into their gas deposit.

`grpc` is how the client reaches the network:

- For the devnet pre-alpha, in a browser or in Node, pass a `DWalletGrpcClient` from
  `@ika.xyz/sdk-core/web`, made with the `https://` URL of the network's gRPC-Web endpoint. This
  client sends its calls through `fetch`, so it works in Node too. In a browser bundle, a plain
  `https://` URL string works as well.
- In Node against validators, pass a validator's `host:port` string. The client then pins TLS to
  the network key of a member of the committee the network signed, and checks that committee against
  Solana.
- For a local node that serves plaintext, pass `{ url, insecure: true }`.

Reads of Solana go through `connection`. To read through something else, pass
`getAccount(address)`, a function that returns an account's owner and data, or `null`.

## Mock mode for the pre-alpha

The devnet pre-alpha needs the client in mock mode. Wrap the client's options in
`withMockCryptography`, from the separate entry `@ika.xyz/sdk-core/mock`:

```ts
import { withMockCryptography } from '@ika.xyz/sdk-core/mock';

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

The values are on [the devnet pre-alpha](../getting-started/devnet.md) page.

In mock mode the SDK skips its 2PC-MPC computations: the user's half of the key generation, the
encryption and decryption of the share, and the user's half of each signature. Every other check
stays: the network's signatures on its answers, the records on Solana, the holder's acceptance of a
share, and each signature against the dWallet's public key.

Mock mode is safe to leave in the code by mistake, for three reasons:

- Mock mode needs a custom network.
- A client in mock mode refuses a network that serves a real network key.
- Mock mode belongs to one client. Every other client, in the same process too, refuses the mock's
  values with the error "mock values need the SDK's mock feature".

The main entry of `@ika.xyz/sdk-core` never imports `/mock`, so an app that does not import it ships
no mock code.

In mock mode, importing a key does not read the key you pass. The mock makes a new key for the
dWallet, so your key never leaves your device, and the imported dWallet has a different public key.

## The flow

Each step below that changes Solana is a transaction the user's wallet signs. A helper keeps the
examples short:

```ts
import { IkaTransaction, UserShareEncryptionKeys, Curve } from '@ika.xyz/sdk-solana/web3';
import { Transaction } from '@solana/web3.js';

const keys = await UserShareEncryptionKeys.fromRootSeedKey(rootSeed, Curve.ED25519);

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
	await connection.confirmTransaction(signature, 'finalized');
}
```

The network reads Solana at finalized commitment. So wait for each transaction to be finalized
before the request that depends on it.

`ikaTx.signers` holds the keypairs of the vouchers the transaction creates. A voucher lives at a
fresh address that signs its own creation, so the transaction needs those signatures too.

**Once per root seed:** register the encryption key and open the gas deposit.

```ts
await send((ikaTx) => ikaTx.registerEncryptionKey({ curve: Curve.ED25519 }));
await send((ikaTx) =>
	ikaTx.createGasDeposit().topUpGasDeposit({ ikaTokenAccount, ikaAmount, solAmount }),
);
```

The registration goes in a transaction of its own. It takes 876 of the 1,232 bytes a Solana
transaction holds. The gas deposit pays for every request the user's request key signs. The devnet
pre-alpha charges nothing, so there `createGasDeposit()` alone is enough.

A user registers an encryption key once for each curve they use. The gas deposit is one for all
curves, because the request key does not depend on the curve.

**Create a dWallet:**

```ts
const { dWallet } = await ikaClient.requestDWalletDKG({
	curve: Curve.ED25519,
	userShareEncryptionKeys: keys,
	owner: wallet.publicKey,
});
await send((ikaTx) => ikaTx.acceptEncryptedUserShare({ dWallet }));
const address = await ikaClient.waitForDWallet(dWallet);
```

The network writes the dWallet on Solana and leaves the user's share waiting there. The user's
acceptance makes the dWallet usable. The holder's signature is what the program checks, so anyone
may send the acceptance. `waitForDWallet` returns once Solana shows the dWallet active.

**Sign a message:**

```ts
let signatureVoucher!: PublicKey;
await send(async (ikaTx) => {
	signatureVoucher = await ikaTx.approveMessage({ dWallet, message, signatureAlgorithm, hashScheme });
});
const signature = await ikaClient.requestSign({
	dWallet,
	signatureVoucherId: signatureVoucher,
	message,
	signatureAlgorithm,
	hashScheme,
	userShareEncryptionKeys: keys,
});
```

`requestSign` reads the voucher on Solana first. It throws before computing anything when the
voucher is for another dWallet, message or scheme. `signatureAlgorithm` and `hashScheme` may be left
out, and the sign then uses the voucher's scheme. Given no `presign`, the sign takes one from the
network's pool. The SDK checks the signature against the dWallet's public key before it returns it.

An ECDSA signature is 65 bytes: the recovery byte, then `r` and `s`. Pass `signature.slice(1)` to a
verifier that takes 64 bytes.

**Hand the dWallet to a program:**

```ts
await send((ikaTx) => ikaTx.transferDWallet({ dWallet, newOwner: programCpiAuthority }));
```

After this, only the program can issue vouchers for the dWallet. The app still sends the sign
request, naming the voucher the program issued.

## Every request

`IkaClient` has the same calls on every chain:

| Call | What it does |
| --- | --- |
| `requestDWalletDKG` | Create a dWallet. With `signDuringDKGRequest`, also sign one message. |
| `requestDWalletDKGWithPublicUserShare` | Create a dWallet whose user share is public. |
| `requestImportedKeyDWalletVerification` | Create a dWallet from a key the user holds. |
| `requestGlobalPresign`, `requestGlobalPresigns` | Take presigns from the network's pool. |
| `requestPresign` | Take a presign made for one imported-key dWallet, for its ECDSA signs. |
| `requestSign` | Sign under a signature voucher. Takes its own presign when given none. |
| `requestFutureSign`, `futureSign` | Sign in two steps: the user's half now, the rest later. |
| `makeDWalletUserSecretKeySharesPublic` | Make a dWallet's user share public. This cannot be undone. |
| `requestReEncryptUserShareFor`, `receiveEncryptedUserShare` | Give a dWallet's share to another user, who then accepts it. |
| `getDWallet` | Read a dWallet on Solana, checked for the keys' holder. |

A future sign has three steps after `requestFutureSign`:

1. Wait for the partial signature on Solana with `waitForPartialUserSignature`.
2. Set the voucher's signing key again with `IkaTransaction.setFutureSignatureVoucherSigningKey`,
   because step 1 clears it.
3. Call `futureSign`.

## Errors an app handles

- **`PresignExpiredWithTheEpoch`.** You passed a presign, and the chain is already past the presign's
  epoch. Nothing was sent. Take a new presign and sign again.
- **`EpochClosedBeforeAnswer`.** The request's epoch closed before the network answered. The request
  may still have run in that epoch, so the SDK does not send it again: a new request would open a new
  session and could be charged a second time. The error carries the request's epoch and its session
  identifier, so the app can decide.
- **`TransactionTooLargeError`.** An `IkaTransaction` method would push the transaction over 1,232
  bytes. The method takes its instructions out again. Send what the transaction holds and put the rest
  in a new one.

## Several steps in one transaction

Each `IkaTransaction` method adds instructions to the same transaction. So several approvals, voucher
changes and your own instructions can go out and land together. Add your own instructions with
`ikaTx.add(...)`, so they count towards the size check too.

For a versioned transaction, which can use address lookup tables to fit more, pass `version: 0` in
place of `transaction`, and build it when you send:

```ts
const ikaTx = new IkaTransaction({
	ikaClient,
	version: 0,
	addressLookupTableAccounts,
	owner,
	userShareEncryptionKeys: keys,
});
await ikaTx.approveMessage({ dWallet, message, signatureAlgorithm, hashScheme });
const tx = ikaTx.buildVersionedTransaction({ recentBlockhash }); // already signed by the vouchers
tx.sign([wallet]);
```

## With @solana/kit

`@ika.xyz/sdk-solana/kit` is the same SDK with kit types. Every address is a kit `Address`.
`IkaClient` reads through a kit `Rpc`. `IkaTransaction` returns kit instructions to append to your
transaction message. The voucher's keypair signer is attached to its account, and so are the owner
and the payer when you pass them as signers. So `signTransactionMessageWithSigners` signs the whole
transaction.

```ts
import { IkaClient, IkaTransaction } from '@ika.xyz/sdk-solana/kit';
import {
	appendTransactionMessageInstructions,
	createSolanaRpc,
	createTransactionMessage,
	pipe,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	signTransactionMessageWithSigners,
} from '@solana/kit';

const ikaClient = new IkaClient({ rpc: createSolanaRpc(rpcUrl), grpc, config });
const ikaTx = new IkaTransaction({ ikaClient, owner: walletSigner, userShareEncryptionKeys: keys });
await ikaTx.approveMessage({ dWallet, message, signatureAlgorithm, hashScheme });
const transaction = await signTransactionMessageWithSigners(
	pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(walletSigner, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
		(m) => appendTransactionMessageInstructions(ikaTx.instructions, m),
	),
);
```

Mock mode works the same way on kit: wrap the options in `withMockCryptography`. The kit entry point
still needs `@solana/web3.js` installed, because the SDK builds its instructions with it.

## In a browser

- Use the gRPC-Web client from `@ika.xyz/sdk-core/web`. The network's gRPC-Web endpoint serves a
  public TLS certificate, and the SDK's checks of each answer verify what the network signed.
- The user's device computes its half of every protocol step. On the real network, creating a dWallet
  takes about 10 seconds of computation and a secp256k1 sign about 8. On a page's main thread that
  freezes the page, so call `useWasmWorker()` once at startup, or pass `computeInWorker: true` to
  `IkaClient`. In mock mode there is almost nothing to compute.
- The instruction builders import `Buffer` from the npm `buffer` package. Point your bundler's
  `buffer` at it. With Vite:

  ```ts
  // vite.config.ts
  export default defineConfig({
  	resolve: { alias: { buffer: 'buffer/' } },
  	define: { global: 'globalThis' },
  	optimizeDeps: { include: ['buffer'] },
  });
  ```

  ```ts
  // the page's entry module, before anything else
  import { Buffer } from 'buffer';
  globalThis.Buffer = Buffer;
  ```

The [multisig example](../examples/multisig/01-overview.md) has a React app that does all of this.

## An app paying for its users

Users need no IKA and no SOL when the app pays every cost. There are three costs:

- **Solana fees and rent.** Pass the app's wallet as `payer` to `IkaTransaction`. It pays the fees and
  every account's rent, and the user's wallet signs only as the dWallet's owner.
- **The network's fees, with one app key.** The app's backend holds one `RequestKey` with one gas
  deposit, and signs every user's requests. The client passes a `requestSigner` that sends each
  request's bytes to the backend. The backend checks them with `decodeSignedRequest` against its own
  rules, then signs them with `RequestKey.signRequest`. The user's device still computes its half of
  each signature, so the backend never sees a share and cannot sign anything an owner did not approve.
- **The network's fees, with a deposit per user.** Each user keeps their own request key. The user's
  device signs its consent with `IkaClient.signGasDepositConsent({ requestKey: keys, depositOwner: app })`.
  The app creates the deposit with it (`createGasDeposit(consent)`), owns it, and refills it with
  `topUpGasDeposit({ requestPublicKey })`.

```ts
// The app's backend
const appKey = RequestKey.fromSecretKey(secret);
app.post('/ika/sign-request', async (req) => {
	const request = decodeSignedRequest(req.body.bytes); // kind, chain, owner, fields
	await checkPolicy(req.user, request); // the app's own rules: who, what, how often
	return appKey.signRequest(req.body.bytes);
});

// The app's client
const ikaClient = new IkaClient({
	...options,
	requestSigner: {
		publicKey: appRequestPublicKey,
		signRequest: (bytes) => callBackend('/ika/sign-request', bytes),
	},
});
```

## The lower-level parts

`IkaClient` and `IkaTransaction` are built on the root entry of `@ika.xyz/sdk-solana`, which an app
can use to build its own flow:

- **Addresses.** `dwalletPda`, `gasDepositPda`, `encryptionKeyPda`, `dwalletCoordinatorPda` and the
  others derive each account's address. `approvalMessageDigests` computes the two digests a voucher
  stores from a message and its metadata.
- **Account readers.** `readDWallet`, `readDWalletCoordinator`, `readSignatureVoucherVerified` and
  the others decode the program's accounts. Each returns `null` for data that is not an account of
  its type. `readSignatureVoucherVerified` throws when the voucher is not for the dWallet, message,
  metadata and scheme you expect, and returns the signature only after your verifier accepts it.
- **Instruction builders**, on `@ika.xyz/sdk-solana/instructions`: `createDepositInstructions`,
  `transferOwnershipInstruction`, `issueSignatureVoucherInstruction`, `topUpInstruction` and others.
  This entry is the only one that needs `@solana/web3.js`.
- **Instruction bytes and account tags.** `instructionByte(name)` and `accountDiscriminator(name)`
  look the numbers up by name in a copy of the program's `wire-tables.json`. An unknown name throws
  and lists the names it knows, instead of returning a byte that means something else.

The package's README has the details of each.
