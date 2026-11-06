# Error Reference

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

When the ika program refuses an instruction, the transaction fails with one of two kinds of
error. A check that only this program makes fails with `ProgramError::Custom(code)`, and the
code is in the tables below. A check every Solana program makes fails with one of Solana's own
errors, listed at the end.

Your program sees these codes when its CPI into the ika program fails. The CPI fails the whole
transaction, so the code reaches the client unchanged.

## dWallet errors (4000 to 4074)

These are the codes an integrator can meet. Codes missing from the list are retired and never
returned.

| Code | Name | When |
|---|---|---|
| 4004 | `AuthorityMismatch` | A withdrawal is requested or claimed, or a deposit is handed to a new owner, by a key that is not the deposit's owner. The request key is refused too |
| 4005 | `InvalidDWalletState` | The dWallet is not Active: a voucher, a transfer or an accept needs it Active, or waiting for its holder |
| 4007 | `InvalidCurve` | The network committed a curve the program does not number |
| 4009 | `InvalidAttestation` | A signed message is not where the instruction expects it. For example, no Ed25519 precompile instruction comes right before an accept |
| 4012 | `InvalidNetworkSignature` | The network key named does not match the signer |
| 4013 | `NetworkKeyNotActive` | The network key's record is not active |
| 4014 | `InsufficientGasBalance` | A withdrawal asks for more than the deposit holds |
| 4025 | `ArithmeticOverflow` | A sum would not fit in its integer |
| 4029 | `InvalidTreasuryVault` | The token account passed is not the coordinator's treasury vault |
| 4030 | `Paused` | The coordinator is paused. See [Pauses](../on-chain/pauses.md) |
| 4031 | `InvalidAuthority` | A key being set is all zeros, such as a new owner |
| 4032 | `InvalidPublicKeyLength` | The network committed a public key of the wrong length for its curve |
| 4033 | `InvalidEpoch` | An epoch value is not the one the instruction allows |
| 4036 | `PauserMismatch` | The signer is not the coordinator's pauser |
| 4038 | `EmptyTopUp` | A top-up moves no IKA and no SOL |
| 4040 | `WithdrawalSequenceMismatch` | A withdrawal release names another withdrawal than the pending one |
| 4041 | `WithdrawalIkaAmountMismatch` | A withdrawal release names another IKA amount than the request |
| 4042 | `WithdrawalSolAmountMismatch` | A withdrawal release names another SOL amount than the request |
| 4045 | `TooManyPausedSigningParameters` | A pause would make a list of paused signing parameters too long |
| 4046 | `UnsupportedEncryptionKeyCurve` | An encryption key is registered for a curve above 3 |
| 4047 | `UnsupportedEncryptionKeySignatureScheme` | An encryption key's holder uses a signature scheme other than Ed25519 |
| 4048 | `InvalidEncryptionKeySignature` | The precompile before a registration does not hold exactly one signature by the holder |
| 4049 | `InvalidEncryptionKeyRegistrationSignature` | The signed registration message is for another chain, network or curve |
| 4050 | `EncryptionKeyHolderMismatch` | The holder account is not the key that signed the registration |
| 4057 | `SourceShareOfAnotherDWallet` | A re-encrypted share names a source share of another dWallet |
| 4059 | `VoucherNotPending` | A voucher's signing key is set, or the voucher revoked, after it ended |
| 4060 | `NotVoucherOwner` | The signer is not the voucher's owner |
| 4062 | `FutureVoucherNotOpenForStep` | A future voucher is not in the state the step needs |
| 4070 | `DkgOutputDigestMismatch` | A network key's record holds another key-generation digest |
| 4071 | `ReconfigurationOutputDigestMismatch` | A reconfiguration record holds another digest |
| 4072 | `ShareOfAnotherDWallet` | The share accepted belongs to another dWallet |
| 4073 | `ShareAlreadyAccepted` | The share was already accepted |
| 4074 | `InvalidAcceptanceSignature` | The acceptance is not one signature by the holder over the share's digest |

The program also defines codes 4000 to 4003, 4006, 4008, 4010, 4011, 4015 to 4024, 4026 to
4028 and 4034. The current program returns none of them. They keep their numbers so that an old
client reads a code the same way.

## The examples' own errors

The example programs return codes of their own, from 0 up. One belongs to every integrator's
checklist: `InvalidBump`, 11 in the voting programs and 12 in the multisig programs. It refuses a
bump a client chose that is not the canonical bump of its seeds. See
[invariant 6](../on-chain/integrator-invariants.md#6-use-the-canonical-bump-for-every-account-whose-existence-enforces-once).

## Program-wide errors (900 to 906)

These belong to the program's upgrade path, which only the network uses. An integrator meets
none of them.

## Solana's own errors

| Error | Usual cause in this program |
|---|---|
| `InvalidAccountOwner` | An account that should be the ika program's is owned by another program |
| `InvalidAccountData` | An account has the wrong tag or the wrong length for its type |
| `InvalidInstructionData` | The instruction data is not exactly the length its layout gives, or a flag byte has an unknown bit |
| `MissingRequiredSignature` | A required signer did not sign. For a CPI, the caller's CPI authority does not match the owner |
| `InvalidArgument` | The caller program is not executable, or the CPI authority is not its `["__ika_cpi_authority"]` address |
| `InvalidSeeds` | An account is not at the address its seeds and bump give |
| `AccountAlreadyInitialized` | The account to create already exists. A voucher address that holds anything fails here |
| `NotEnoughAccountKeys` | The instruction got fewer accounts than it needs |
| `IncorrectProgramId` | The system program or the token program passed is not the real one. From a CPI crate's `DWalletContext`: the `dwallet_program` passed is not the ika program the crate was built for, and nothing was called |

Every instruction's data must be exactly the length its layout gives. A longer or shorter
instruction is refused with `InvalidInstructionData`, even when the extra bytes are zeros.
