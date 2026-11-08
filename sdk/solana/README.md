# @ika.xyz/pre-alpha-solana

The Solana part of the ika dWallet network client: the addresses the `ika_protocol` program keeps
its accounts at, the instruction bytes and account discriminators it answers to, readers for the
accounts it writes, and builders for the instructions a client sends it.

Every number comes from the program's own wire table, by name. The package keeps it as
`src/wire-tables-data.ts`. A name the table does not have throws instead of returning a default.

> **Pre-alpha.** The Solana devnet pre-alpha is a mock ika network with no MPC. Read the warning in
> the docs (`docs/src/introduction.md`) before you build anything.

The requests themselves, and the checks of the network's attestations, are the same on every chain
and live in `@ika.xyz/pre-alpha-core`.

## The dWallet SDK

The ika dWallet SDK for the network's request flow on Solana. It has three classes:

- `UserShareEncryptionKeys`: the user's keys, derived from one root seed the app keeps.
- `IkaTransaction`: adds the chain's dWallet calls to a transaction the app's wallet signs.
- `IkaClient`: sends the network's requests, such as create, presign and sign, and reads the chain.

It has two entry points. Import `@ika.xyz/pre-alpha-solana/web3` with `@solana/web3.js`, or
`@ika.xyz/pre-alpha-solana/kit` with `@solana/kit`. The root, `@ika.xyz/pre-alpha-solana`, needs neither.

The part every chain shares, the request engine and the user's keys, is in
`@ika.xyz/pre-alpha-core/common`. This package re-exports what an app uses from it.

### How requests are paid for

Requests go to the network directly, not through Solana. Each request is signed by a request
key and charged to that key's gas deposit on the chain. The request key comes from the root seed, so
the wallet never signs raw bytes: it signs only chain transactions. Those are the registration of
the encryption key, the gas deposit, and the vouchers that approve a message.

The request key does not depend on the curve, so one gas deposit serves every curve.

### Before you start

Install this package and `@solana/web3.js`, or `@solana/kit` and `@solana/web3.js` for the kit entry
point.

The examples below use these values. Each comes from your app or from the network you connect to.

- **`rootSeed`**: 32 random bytes, made once per user (`crypto.getRandomValues(new Uint8Array(32))`)
  and kept as a secret. Every key of the user comes from it, on any device. A user who loses it
  loses the shares of their dWallets.
- **`validatorUrl`**: a validator's address, as the network publishes it. See
  [Connecting to the validators](#connecting-to-the-validators).
- **`connection`**: a `@solana/web3.js` `Connection`, or a kit `Rpc` for the kit entry point.
- **`config`**: where the network is: `{ network, programId }`. `network` is `'mainnet'`, `'testnet'`, or for any other network
  `{ custom: { networkPublicKeys } }`. A custom network also needs `chainNumber` and `networkValue`, on `config`. Take them from the network's operator, never from an RPC answer:
  the SDK checks every answer against the network keys, and the registration and the gas deposit
  sign over the chain number and the network. The program's coordinator account records both
  (`readDWalletCoordinator`). For the devnet pre-alpha they are chain number `1` and network value `3`.
- **`ikaTokenAccount`**: a token account of IKA, which pays ika's fees on Solana.
- **`ikaAmount`, `solAmount`**: what goes into the gas deposit, in base units. Each
  request is charged from it at the network's current prices. Top it up with `topUpGasDeposit` when
  it runs low.

### The flow, with `@solana/web3.js`

`IkaTransaction` takes the wallet's address as `owner`. A voucher lives at
a fresh address that signs its own creation, so `approveMessage` returns that address and adds its
keypair to `signers`. Sign the transaction with `signers` too.

```ts
import {
	Curve,
	Hash,
	IkaClient,
	IkaTransaction,
	SignatureAlgorithm,
	UserShareEncryptionKeys,
} from '@ika.xyz/pre-alpha-solana/web3';
import { Transaction } from '@solana/web3.js';

const ikaClient = new IkaClient({ connection, grpc: validatorUrl, config: { network, programId } });

// Once: the registration goes in a transaction of its own, since it carries the whole key.
await sendWithWallet(
	new IkaTransaction({
		ikaClient,
		transaction: new Transaction(),
		owner,
		userShareEncryptionKeys: keys,
	}).registerEncryptionKey({ curve }),
);
const deposit = new IkaTransaction({
	ikaClient,
	transaction: new Transaction(),
	owner,
	userShareEncryptionKeys: keys,
});
await deposit.createFundedGasDeposit({ ikaTokenAccount, ikaAmount, solAmount });
```

The network sets a minimum first deposit on the coordinator (`getDWalletCoordinator().minFirstDeposit`).
A create and every top-up must leave the deposit, net of its debt, at or above it in each coin.
`createFundedGasDeposit` and `topUpGasDeposit` read it first and throw `GasDepositBelowMinimumError`,
which names the minimum, for amounts the program would refuse. A second minimum, `minBalance`, is
what the validators require before they accept a new request paid from the deposit. Each coin a
top-up adds must be zero or at least `minBalance` in that coin; `topUpGasDeposit` throws
`GasTopUpBelowMinimumError`, which names the coin, the amount and the minimum, otherwise.
`topUpGasDeposit` reads the deposit first and throws for a request key with no deposit, so open a
deposit with `createFundedGasDeposit`, not with `createGasDeposit().topUpGasDeposit(...)` in one
transaction. The empty `createGasDeposit()` is accepted only while the minimum first deposit and
the deposit fee are both zero.

Every create, reopen and top-up also pays the network's deposit fee in SOL
(`getDWalletCoordinator().depositFee`). The program takes the fee out of the SOL the instruction
moves and credits the rest. `createFundedGasDeposit` and `topUpGasDeposit` take the amounts to
CREDIT and add the current fee themselves, so the payer sends `solAmount` plus the fee, a top-up of
IKA alone sends the fee alone, and the minimums are checked on the credited amounts. The raw
builders `createDepositInstructions` and `topUpInstruction` take the SOL the instruction moves, fee
included.

A withdrawal returns the whole deposit. `requestGasWithdrawal({ ikaDestination })` takes no amount,
and it is final: there is no cancel. The network then pays the deposit out with its own
transaction, after its charge: the SOL to the owner and the IKA to `ikaDestination`. There is no
claim step. A payout that pays everything closes the deposit and ends its life, which the deposit's
`incarnation` counts. `createFundedGasDeposit` on a closed deposit reopens it as its next life: it
reads the deposit and signs, or takes in `consented`, the proof for the closed deposit's incarnation
plus one (`IkaClient.signGasDepositReopenConsent`), and it throws `GasDepositAlreadyOpenError` for a
deposit that is open or pending. `topUpGasDeposit`, `requestGasWithdrawal` and `transferGasDeposit`
read the deposit and throw `GasDepositClosedError` for a closed one. A request and a transfer name
the deposit's open life; an `incarnation` passed for another life throws
`GasDepositIncarnationMismatchError`, as the program would refuse it
(`GasDepositIncarnationMismatch`, 4081). A top-up names no life, so it lands on whatever life is open
when it executes. `transferGasDeposit({ newOwner })` hands the deposit to a new owner. A request is
final, so it throws `TransferWhileWithdrawalPendingError` while a withdrawal is pending, as the
program would refuse the transfer (`TransferWhileWithdrawalPending`, 4079). `getGasDeposit` reads a deposit, and
`gasDepositEvents` decodes the program's deposit events from a transaction's inner instructions.

```ts
const { dWallet } = await ikaClient.requestDWalletDKG({
	curve,
	userShareEncryptionKeys: keys,
	owner,
});
// The holder accepts the share on Solana, which makes the dWallet usable.
// The holder's signature is the only authority, so anyone may send it.
await sendWithWallet(
	new IkaTransaction({ ikaClient, transaction: new Transaction(), owner }).acceptEncryptedUserShare({
		dWallet,
	}),
);
// Returns once the dWallet is active, that is, once Solana shows the acceptance.
await ikaClient.waitForDWallet(dWallet);

const tx = new Transaction();
const ikaTx = new IkaTransaction({
	ikaClient,
	transaction: tx,
	owner,
	userShareEncryptionKeys: keys,
});
const signatureVoucher = await ikaTx.approveMessage({
	dWallet,
	message,
	signatureAlgorithm,
	hashScheme,
});
tx.partialSign(...ikaTx.signers); // after the recent blockhash is set
await wallet.sendTransaction(tx, connection); // wait for finalized: the validators read it there

const signature = await ikaClient.requestSign({
	dWallet,
	signatureVoucherId: signatureVoucher,
	message,
	userShareEncryptionKeys: keys,
});
```

### The flow, with `@solana/kit`

`@ika.xyz/pre-alpha-solana/kit` is the same SDK with `@solana/kit` types: every address is a kit
`Address`, `IkaClient` reads through a kit `Rpc`, and `IkaTransaction` returns kit `Instruction`s to
append to your transaction message. The voucher's keypair signer is attached to its account, and so
are the owner and the payer when you pass them as signers, so `signTransactionMessageWithSigners`
signs the whole transaction. The SDK builds the instructions with `@solana/web3.js` inside, so that
package must be installed too, though your code never uses it.

```ts
import { IkaClient, IkaTransaction, UserShareEncryptionKeys } from '@ika.xyz/pre-alpha-solana/kit';
import {
	appendTransactionMessageInstructions,
	createSolanaRpc,
	createTransactionMessage,
	pipe,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	signTransactionMessageWithSigners,
} from '@solana/kit';

const ikaClient = new IkaClient({
	rpc: createSolanaRpc(rpcUrl),
	grpc: validatorUrl,
	config: { network, programId },
});
const ikaTx = new IkaTransaction({ ikaClient, owner: walletSigner, userShareEncryptionKeys: keys });
const signatureVoucher = await ikaTx.approveMessage({
	dWallet,
	message,
	signatureAlgorithm,
	hashScheme,
});
const transaction = await signTransactionMessageWithSigners(
	pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(walletSigner, m),
		(m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
		(m) => appendTransactionMessageInstructions(ikaTx.instructions, m),
	),
);
// Send it, and wait for finalized: the validators read it there. Then sign as on web3.js.
```

### Connecting to the validators

`grpc` takes a validator's URL. In Node it is `host:port`, and the client pins TLS to the network
key of a member of the committee the network signed, which it checks against the chain `IkaClient`
reads. In a browser it is the `https://` URL of the validator's gRPC-Web listener. For a localnet
node that serves plaintext, pass `{ url, insecure: true }`. To use further validators, or your own
TLS settings, make a `DWalletGrpcClient` yourself and pass it instead: this package exports the Node client in
Node and the gRPC-Web client in a browser bundle.

### Keeping the page responsive

The user's device computes its half of every protocol step. Creating a dWallet takes about 10
seconds of computation, a secp256k1 sign about 8, and deriving the keys about 5. On a browser's main
thread, that freezes the page. Call `useWasmWorker()` once at startup, or pass
`computeInWorker: true` to `IkaClient`, and these computations run in a worker. The results are the
same. The setting is for the whole page or process. A worker made after keys were derived does not
move that earlier work, so call `useWasmWorker()` first.

The SDK starts its worker with `new Worker(new URL(..., import.meta.url))`, which Vite and webpack
ship on their own. If your bundler does not, make the worker yourself and pass it:

```ts
useWasmWorker(
	new Worker(new URL('@ika.xyz/pre-alpha-core/wasm-worker', import.meta.url), { type: 'module' }),
);
```


### Several steps in one Solana transaction

Each `IkaTransaction` method adds instructions to the same transaction, so several approvals,
voucher changes and your own instructions can go out together and land together. Add your own with
`ikaTx.add(...)` so they are measured too.

A Solana transaction holds at most 1,232 bytes. Each method measures the whole transaction after it
adds its instructions, and when it would be over the limit, it takes them out again and throws
`TransactionTooLargeError`. Send what the transaction holds, and put the rest in a new one. The
encryption key's registration alone takes 876 bytes, so it always goes in a transaction of its own.

For a versioned transaction, which can use address lookup tables to fit more, pass `version: 0`
instead of `transaction`, and build it when you send:

```ts
const ikaTx = new IkaTransaction({
	ikaClient,
	version: 0,
	addressLookupTableAccounts,
	owner,
	userShareEncryptionKeys: keys,
});
await ikaTx.approveMessage({ dWallet, message, signatureAlgorithm, hashScheme });
const { blockhash } = await connection.getLatestBlockhash();
const tx = ikaTx.buildVersionedTransaction({ recentBlockhash: blockhash }); // signed by the vouchers
await wallet.sendTransaction(tx, connection);
```

### An app paying for its users

Users never need IKA or SOL: the app can pay every cost. There are three costs, and each can be
the app's.

- **Chain fees and rent.** Pass the app's wallet as `payer` to `IkaTransaction`: it pays every
  account's rent and is the fee payer, and the user's wallet signs only as the dWallet's owner.
- **ika's request fees.** Each request is charged to the gas deposit of the key that signs it. Two
  ways to make that the app's:
  - **One app key.** The app's backend holds a `RequestKey` with one gas deposit, and signs every
    user's requests. Clients pass a `requestSigner` that sends each request's bytes to the backend;
    the backend checks them with `decodeSignedRequest` against its own rules, then signs them with
    `RequestKey.signRequest`. The user's device still computes its half of each signature, so the
    backend never sees a share, and it cannot sign anything a dWallet's owner did not approve.
  - **Sponsored per-user deposits.** Each user keeps their own request key. The user's device signs
    its consent with `IkaClient.signGasDepositConsent({ requestKey: keys, depositOwner: app })`; the
    app creates the deposit with it (`createFundedGasDeposit({ consented: consent, ... })`), owns
    it, and refills it with
    `topUpGasDeposit({ requestPublicKey })`.

  Either way, a request names the life (`incarnation`) of the deposit at the key that signs it, and
  the client reads that life from Solana just before it signs. With one app key, that is the app's
  own deposit.

```ts
// The app's backend
const appKey = RequestKey.fromSecretKey(secret);
app.post('/ika/sign-request', async (req) => {
	const request = decodeSignedRequest(req.body.bytes); // kind, chain, owner, fields
	await checkPolicy(req.user, request); // the app's rules: who, what, how often
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

### Every request

`IkaClient` has the same calls on every chain:

| Call                                                       | What it does                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `requestDWalletDKG`                                        | Create a zero-trust dWallet; with `signDuringDKGRequest`, also sign one message |
| `requestDWalletDKGWithPublicUserShare`                     | Create a dWallet whose user share is public                                     |
| `requestImportedKeyDWalletVerification`                    | Create a dWallet from a key the user holds                                      |
| `requestGlobalPresign`, `requestGlobalPresigns`            | Take presigns from the network's pool                                           |
| `requestPresign`                                           | Take a presign made for one imported-key dWallet (its ECDSA signs)              |
| `requestSign`                                              | Sign under a signature voucher; takes its own presign when given none           |
| `requestFutureSign`, `futureSign`                          | Sign in two steps: the user's half now, the rest later                          |
| `makeDWalletUserSecretKeySharesPublic`                     | Make a dWallet's user share public                                              |
| `requestReEncryptUserShareFor`, `receiveEncryptedUserShare` | Give a dWallet's share to another user; the receiver then sends `dWallet.acceptance` |
| `getDWallet`                                               | Read a dWallet on the chain, checked for the keys' holder                       |

A sign, and step 1 of a future sign, read the voucher first. They throw before computing anything
when the voucher is for another dWallet, message or scheme. `signatureAlgorithm` and `hashScheme`
may be left out: the sign then uses the voucher's scheme.

Given no `presign`, a sign takes its own. When the chain moves past that presign's epoch before
the sign is sent, it takes a new one. Given a `presign`, it throws `PresignExpiredWithTheEpoch`
when the chain is already past the presign's epoch. Nothing was sent then, so take a new presign
and sign again.

A request whose epoch closes before the network answers it throws `EpochClosedBeforeAnswer`. The
request may still have run in that epoch, so the SDK never sends it again on its own: a new request
would open a new session, and could be charged a second time. The error carries the request's
epoch and its session identifier, so the app can decide what to do. Every request names the epoch
the chain shows.

A future sign takes three steps after `requestFutureSign`:

1. Wait for the partial signature on the chain (`waitForPartialUserSignature`).
2. Set the voucher's signing key again (`IkaTransaction.setFutureSignatureVoucherSigningKey`),
   because step 1 clears it.
3. Call `futureSign`.

## The parts the SDK is built on

The rest of this README is the lower-level part of the package: the addresses, the account readers
and the instruction builders the SDK's classes call, for an app that builds its own flow.

### Entry points

- `@ika.xyz/pre-alpha-solana`: the addresses, the account readers, the wire tables, the reader and record
  check for the core's ownership check (the reader's `readDWalletAt` reads a dWallet by its account,
  and refuses an account that is not at its own dWallet's derived address, for `readDWalletVerified`
  of `@ika.xyz/pre-alpha-core`). It also has `solanaCommitteeReader(programId, getAccount, crossCheck, network)`,
  the `committeeReader` the core's gRPC client takes. The network signs each epoch's committee, and
  the client pins its TLS connections to the network key of a member of a committee it checked. This
  reader gives the two Solana reads that check uses: the program's `SystemState.epoch`, and whether
  a network key's `NetworkEncryptionKey` account exists. It needs nothing installed but `@noble`,
  `@mysten/bcs` and the core. No presign is kept on chain: a presign lives only for the epoch it
  was made in, so a future sign gets its presign and sends its first step in the same epoch.
- A voucher's signature is read with `readSignatureVoucherVerified(data, expected, verifySignature)`
  or `readFutureSignatureVoucherVerified`. One RPC serves the account, so the read requires the
  voucher to be for the dWallet, the message, the metadata and the scheme in `expected`. It returns
  the signature only after `verifySignature` accepts it. A caller of `@ika.xyz/pre-alpha-core` passes a
  function that calls `verifySignatureWithScheme` with a dWallet output it already checked.
  `readSignatureVoucherUnverified` and `readFutureSignatureVoucherUnverified` only decode the account.
  They are for uses that need no signature, such as waiting for the status or reading the signing key.
- A future voucher's partial-signature attestation is checked with
  `verifySolanaPartialSignatureVoucher(voucher, voucherAddress, trustedNetworkKeys)`. The voucher
  stores the attestation's fields and its proof envelope, and no hash, and the program checks
  neither. The check decodes the proof, rebuilds the bytes from the fields at the proof's version,
  verifies the network's signature under a trusted key, and requires the attestation to name this
  voucher's address, message digest, metadata digest and signature scheme.
- `@ika.xyz/pre-alpha-solana/instructions`: the instruction builders, which return `@solana/web3.js`
  instructions. `@solana/web3.js` is a peer dependency, and only this subpath needs it.

A guide with examples is `docs/src/frameworks/typescript.md`.

### Mainnet, testnet, and other networks

Every read that checks a network signature, and every reader of a network key's account, takes the
network you chose: `'mainnet'`, `'testnet'`, or `{ custom: { networkPublicKeys } }` for a local
network or any other network (`IkaNetwork` of `@ika.xyz/pre-alpha-core`). Build the trusted keys with
`trustedNetworkKeys(network)` of `@ika.xyz/pre-alpha-core`.

- On mainnet and testnet the SDK trusts only the network keys it lists.
  `readSolanaNetworkKeyOutputVerified`, `solanaNetworkKeyOutputRecordReader` and
  `solanaCommitteeReader` refuse a key the list does not hold, a `NetworkEncryptionKey` account at
  another address than the listed one, and an account that holds another DKG digest. Pass
  `readEncryptionKey` the chain number `deployedSolanaChainNumber(network)` of `@ika.xyz/pre-alpha-core`
  gives, and the network `deployedNetworkValue(network)` gives.
- On a custom network the SDK checks the reads against no list, and you pass the chain number and
  the network from your own configuration: the fixed number the protocol config gives Solana (1 on
  every network), and the network value (3 for a local network). A holder's encryption key
  registration and a gas deposit's proof of possession sign the number and the network, never the
  chain's ERC-7930 label, which the network can change. The number alone is the same on mainnet and
  testnet, so the network is what keeps a testnet signature from verifying on mainnet.

**The new flow is not deployed on mainnet or testnet yet.** So the lists ship empty, and every
mainnet and testnet path that needs a network key refuses until a release fills them. Testnet's
chain number ships empty too.

`readEncryptionKey` takes a required `crossCheck`. No network signature covers a holder's registry
entry, so pass `{ getAccount }` of a second endpoint another provider runs: the entry is then read
and checked through both, and refused unless both serve the same key and signature. An endpoint that
has no entry yet is read again for up to 10 seconds, and one that fails refuses the read.
`'not-cross-checked'` reads it through `getAccount` alone.

Three more readers take the same required `crossCheck` (`SolanaReadCrossCheck`), for reads that no
network signature covers either:

- `solanaCommitteeReader` reads the program's `SystemState.epoch` through both endpoints, on every
  network. A lying endpoint that served an older epoch would let a former committee pass the
  committee check. `getAccount` reports no slot, so the epoch itself is the position: the epoch only
  grows, so the endpoint that shows the lower one is read again until it catches up, or for up to
  10 seconds before the read is refused.
- `solanaNetworkKeyOutputRecordReader` and `readSolanaNetworkKeyOutputVerified` read whether a
  signer is registered through both endpoints, on a custom network only: both must find its
  `NetworkEncryptionKey` account with the same DKG output digest, or both find none. On mainnet and
  testnet the list decides which keys are registered, and a lie can only say a listed key's account
  is absent, which refuses the signature.
- `dwalletShareReader` reads whether the dWallet has a public share attestation through both
  endpoints, on every network. Nothing signs an absence, and an endpoint that hid the account would
  have a request built for an encrypted share, which the network refuses and charges. The account is
  absent only when both endpoints find none, and two present accounts must hold the same record.
- `solanaNetworkKeyOutputRecordReader` and `readSolanaNetworkKeyOutputVerified` read the output
  records through `getAccount`: the check requires every record to carry the network's proof,
  signed by a registered network key. Only the signer's registration is cross-checked, on a custom
  network.

### The devnet pre-alpha: mock mode

The Solana devnet pre-alpha runs on a mock ika network: one backend stands in for the validators. It holds an ordinary key for each dWallet, signs with it,
and writes every result to the Solana program as the network does. There is no MPC.

**It is not secure.** The backend holds the whole key of every dWallet and can sign anything with
it. Use it only with funds you can lose.

**No private key is sent to the backend.** The backend makes every dWallet's key itself. In mock mode
an import does not read the key you pass: the backend makes a new key for the dWallet, so an imported
dWallet of the pre-alpha has another public key and address than the key you imported, and that key
never leaves your device.

The mock cryptography is a separate entry, `@ika.xyz/pre-alpha-core/mock`, so add `@ika.xyz/pre-alpha-core` to
your dependencies. The package's main entry never imports it: an app that does not import `/mock`
ships no mock code.

Create the client with `withMockCryptography` and a custom network that names the mock's network
key. The mock prints its network key, its program, its chain number and its network value when it
starts:

```ts
import { withMockCryptography } from '@ika.xyz/pre-alpha-core/mock';

const ikaClient = new IkaClient(
	withMockCryptography({
		connection,
		grpc: mockUrl,
		config: {
			network: { custom: { networkPublicKeys: [mockNetworkKey] } },
			programId,
			chainNumber,
			networkValue,
		},
	}),
);
```

In mock mode the SDK skips its 2PC-MPC computations: the user's half of the key generation, the
share's encryption and decryption, and the user's half of each signature. It sends the curve in place
of the user's half of the key generation, and nothing in place of the user's half of a signature. Every other check stays:
the network's signatures on its answers, the records on Solana, the holder's acceptance, and each
signature against the dWallet's public key. Everything else in this README holds unchanged.

Mock mode is allowed only with a custom network. A client in mock mode refuses a network that serves
a real network key, and a client without it refuses the mock's network key. Mock mode belongs to
one client: every other client, in the same process too, refuses the mock's values with the error
"mock values need the SDK's mock feature".

### In a browser

Both entry points load in a page. Neither imports anything from Node.

- The readers take a `getAccount(address)` function, not an RPC client, so any Solana RPC client
  that runs in a browser can back them. Solana's public RPC endpoints answer browsers, but they are
  rate-limited and meant for light use. A production app uses its RPC provider's endpoint.
- Send requests to the validators through the browser client of `@ika.xyz/pre-alpha-core/web`. Pass it to
  `readSolanaNetworkKeyOutputVerified(programId, getAccount, crossCheck, network, validators, networkKeyId)` as
  `validators`: the read checks the served outputs against the network key's account on Solana, so
  the check holds whichever server answered.
- `solanaCommitteeReader` is for the Node client only. The browser client refuses a
  `committeeReader`, because pinning a connection to the committee needs a raw TLS connection, which
  a browser does not give a page. What a browser trusts its endpoint for instead is in the README of
  `@ika.xyz/pre-alpha-core`, under "In a browser".
- `./instructions` imports `Buffer` from the npm `buffer` package, by name, and returns
  `@solana/web3.js` 1.x instructions. A bundler must resolve `buffer` to the npm package, not to
  Node's module of the same name. The multisig demo (`examples/multisig/react`) does
  that with Vite, and also sets a global `Buffer` for the libraries it bundles that expect one:

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

### Build and test (in this repository)

```bash
pnpm install
pnpm --filter @ika.xyz/pre-alpha-core build
pnpm --filter @ika.xyz/pre-alpha-solana build
pnpm --filter @ika.xyz/pre-alpha-solana typecheck
pnpm --filter @ika.xyz/pre-alpha-solana test
```

`build` writes `dist/esm`: esbuild transpiles each source file, and `tsc` writes the declarations.
`typecheck` type-checks the source and the tests together. The tests import `@ika.xyz/pre-alpha-core` by
name, so build the core first.

The package is ES modules only.

### License

BSD-3-Clause-Clear
