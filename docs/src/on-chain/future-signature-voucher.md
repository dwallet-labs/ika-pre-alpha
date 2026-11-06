# Future Signature Vouchers

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

A future sign splits one signature into two steps that can happen at different times. In step 1
the user does its half of the signature now, and the network checks it and keeps the result. In
step 2 the network completes the signature, later, when the owner allows it. The user does not
need to be online for step 2.

This suits a program that collects the user's consent first and decides later. For example, a
user signs an order now, and the program releases it when a price is reached.

A `FutureSignatureVoucher` is the on-chain permission for one future sign. It works like a
[signature voucher](./signature-voucher.md), with one more state between pending and signed.

## The flow

1. The dWallet's owner issues a future voucher with `IssueFutureSignatureVoucher`. Its signing
   key is the key step 1 must be signed by.
2. The user sends step 1 over gRPC (`FutureSign`). It names the voucher, a presign, the message,
   and the user's half of the signature.
3. The network checks the user's half. It writes the checked result into the voucher with
   `CommitPartialUserSignature`, and answers with the same result. The write clears the
   voucher's signing key.
4. The voucher's owner sets the key for step 2 with `SetVoucherSigningKey`.
5. Anyone holding that key sends step 2 over gRPC (`SignWithPartialUserSig`, or
   `ImportedKeySignWithPartialUserSig` for an imported dWallet). It carries step 1's result and
   the message.
6. The network completes the signature, answers with it, and writes it into the voucher with
   `CommitSignature`.

Step 3 clears the key on purpose. The key that made step 1 cannot finish the signature unless
the owner names it again. So the owner, often a program, decides when step 2 may happen and who
sends it.

## What the voucher holds

The fields up to offset 172 are those of a `SignatureVoucher`, at the same offsets. Then:

| Offset | Field | Meaning |
|---|---|---|
| 173 | `status` | 0 open, 1 partially signed, 2 signed, 3 closed by a charge, 4 revoked |
| 174 | `attestation_proof` | The network's signature over step 1's result |
| 272 | `has_partial_signature` | 1 once step 1 wrote its result |
| 273 | `attestation_len` | The length of step 1's result |
| 275 | `attestation` | Step 1's result, up to 1536 bytes |
| 1811 | `signature_len` | The signature's length. 0 until signed |
| 1813 | `signature` | The signature, padded to 128 bytes |

The account is 1941 bytes, tag 109. The issuer pays rent for all of it at issue time, so step 1
adds no rent.

## The statuses

| Status | Name | Next |
|---|---|---|
| 0 | Open | Step 1 makes it partially signed |
| 1 | Partially signed | Step 2 makes it signed |
| 2 | Signed | Final |
| 3 | Closed by a charge | Final. The network charged for work it gave up delivering |
| 4 | Revoked | Final for new requests |

The owner can set the signing key, or revoke the voucher, while it is open or partially signed.
A revoke stops new requests. A step that enough validators agreed before the revoke is still written:
a revoked voucher can still take step 1's result, and then its signature. It stays revoked while
it holds step 1's result.

Step 1's write never fails because of what the voucher holds. A voucher that already holds step
1's result, or a signature, keeps it, and the second write changes nothing. Only a voucher closed
by a charge refuses the write (`FutureVoucherNotOpenForStep`, 4062).

## The presign and the epoch

Step 1 uses a presign: the network's half of a signature, made in advance. The presign must be
one of the current epoch, served to the same request key, and not used before. A presign expires
with its epoch.

Step 2 uses no presign. Step 1's result already holds what the presign gave. So step 2 can run in
any later epoch.

## Issuing from a program

The CPI helper takes the same arguments as `issue_signature_voucher`:

```rust
ctx.issue_future_signature_voucher(
    coordinator,
    future_signature_voucher,  // the new voucher's address
    dwallet,
    payer,
    system_program,
    message_digest,
    [0u8; 32],
    signature_scheme,
    None,                      // owner: this program's CPI authority
    Some(user_request_key),    // the key step 1 must be signed by
    Some(&voucher_seeds),
)?;
```

After step 1, the program sets the key for step 2 when its own condition is met:

```rust
ctx.set_voucher_signing_key(future_signature_voucher, completion_key)?;
```

The multisig example uses a future voucher. See `examples/multisig/`.
