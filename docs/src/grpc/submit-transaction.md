# The gRPC API

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

Users talk to the ika network over gRPC. Every dWallet operation, from key generation to
signing, is one call of `SubmitTransaction`. The operation is named inside the signed request,
not by the call. The SDKs build, sign and send these requests, and check the answers. This page
and the next two describe the wire format, for readers who build a client of their own or read
the traffic.

The service is the package `ika.dwallet.v1alpha1`. The SDK carries its definition in `sdk/core/src/grpc/messages.ts`. The API is
alpha: its messages and methods may change without notice.

## Endpoints

| Network | Endpoint |
|---|---|
| Devnet pre-alpha, gRPC-Web | `https://solana-alpha-dev-1.ika-network.net` |

The devnet pre-alpha is served by the mock network. It serves gRPC-Web with a public TLS
certificate. The SDK's gRPC-Web client uses it, in a browser and in Node. A plain gRPC client on this
address gets an HTTP 400 answer.

A validator of the real network serves plain gRPC over TLS. The TLS certificate is made from the
validator's network key, not from a public authority. The SDK's Node client checks it against
the committee the network signed, which it reads from Solana.

## The calls

| Call | What it does |
|---|---|
| `SubmitTransaction` | Sends one signed dWallet request and returns its answer |
| `GetPresigns` | Lists the unused presigns served to one request key |
| `GetPresignsForDWallet` | Lists the unused presigns bound to one imported dWallet |
| `GetNetworkKeyOutput` | Returns a network key's public outputs, which a client needs to compute its half of the cryptography |
| `GetNetworkKeysByAge` | Lists the epoch's active network keys, oldest first, and names the one new dWallets are made under |
| `GetCommittee` | Returns the epoch's committee, signed by the network |

Only `SubmitTransaction` is signed by the user. The other calls are reads. Their answers are
checked against what Solana records, never trusted on the server's word.

## The request

```protobuf
message UserSignedRequest {
  bytes user_signature = 1;      // BCS of UserSignature
  bytes signed_request_data = 2; // BCS of SignedRequestData
}
```

`signed_request_data` is the request itself:

```rust
pub struct SignedRequestData {
    pub session_identifier_preimage: [u8; 32],
    pub epoch: u64,
    pub chain_id: ChainId,             // the chain the request is for: Solana here
    pub intended_chain_sender: Vec<u8>,
    pub request: DWalletRequest,
}
```

| Field | Meaning |
|---|---|
| `session_identifier_preimage` | 32 random bytes. With the epoch and the request key, it names the request's session |
| `epoch` | The epoch the chain shows. On Solana, the `DWalletCoordinator`'s `epoch` |
| `chain_id` | The chain the result is written to. `Solana` for this program |
| `intended_chain_sender` | The user's 32-byte Solana address. A new dWallet's owner is this address |
| `request` | The operation. See [Request Types](./request-types.md) |

`user_signature` signs those bytes with the request key:

```rust
pub enum UserSignature {
    Ed25519 { signature: Vec<u8>, public_key: Vec<u8> },   // 64 and 32 bytes
    Secp256k1 { signature: Vec<u8>, public_key: Vec<u8> }, // 64 and 33 bytes
    Secp256r1 { signature: Vec<u8>, public_key: Vec<u8> }, // 64 and 33 bytes
}
```

On Solana the request key must be an Ed25519 key, because a gas deposit is kept per 32-byte
Ed25519 key. The mock network accepts Ed25519 request keys only.

## What the request key signs

The key does not sign `signed_request_data` alone. It signs a message with a prefix:

```text
0xFF || "ika-request" || signed_request_data
```

The prefix is not sent. The validators add it, then verify. They refuse a signature over the bare
bytes. The first byte, `0xFF`, cannot start a Solana transaction message, so a request key that is
also a Solana wallet never signs a request by mistake.

In TypeScript, `signGrpcRequest` from `@ika.xyz/sdk-core` signs a request, and
`requestSigningMessage` builds the message.

## What the network checks first

Before it runs a request, the network checks, in order:

1. The bytes decode and the signature verifies.
2. The chain is one the network writes to.
3. The epoch is the current one. An earlier epoch is refused with `request epoch E does not match
   current epoch N`. A later epoch is answered `UNAVAILABLE`, so the client sends it again.
4. The session. The same signed bytes sent again get the same answer. Other bytes under the same
   preimage, key and epoch are refused.
5. The request key has a gas deposit on the chain. Otherwise the request is refused with
   `this transport key has no gas deposit on the chain the request names`.

The mock network makes the same checks in the same order.

## The answer

```protobuf
message TransactionResponse {
  bytes response_data = 1; // BCS of TransactionResponseData
}
```

```rust
pub enum TransactionResponseData {
    Signature { signature: Vec<u8> },
    Attestation(NetworkSignedAttestation),
    Error { message: String },
}
```

A sign is answered with the signature. Every other served request is answered with an
attestation: a record the network signed. A refused request is answered with an error message.
See [Response Types](./response-types.md).

A gRPC status of `UNAVAILABLE` means "send the same bytes again later". It is not a refusal. The
SDKs send the same signed bytes again; they never sign a new request for it.

## Presigns

A presign is the network's half of a signature, made in advance and not tied to a message. A
`Presign` request makes one. `GetPresigns` lists the unused ones served to a request key:

```protobuf
message PresignInfo {
  bytes presign_id = 1;          // pass it back in a Sign request
  bytes dwallet_binding_id = 2;  // empty for a presign of the global pool
  uint32 signature_algorithm = 3;
  uint64 assigned_epoch = 4;     // the presign expires with this epoch
}
```

`GetPresignsForDWallet` takes the request key, an imported dWallet's public key and the session
identifier of the import, and lists the presigns bound to that dWallet.
