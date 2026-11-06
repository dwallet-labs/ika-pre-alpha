# The ika program, compiled

The ika program ships here as compiled SBPF v3 programs only.

| File | What it is |
| --- | --- |
| `ika_protocol.so` | The ELF of the program the Solana devnet pre-alpha runs at `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT`: 691,408 bytes. It was built on Linux x86_64 with Agave 4.2.2: `cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha`. |
| `ika_protocol_test.so` | The program built for the local development address, `ika_protocol_program_id::ID` with no network feature: `cargo build-sbf --tools-version v1.54 --arch v3`, on macOS arm64. The LiteSVM tests load it there (`crates/ika-dwallet-litesvm-test`). |

SHA-256:

```
b0c3a8a4e57a78bdfe0b2083f63fb6c9677ad9db38deec1da0d8b32d38a0e55d  ika_protocol.so
df2855dc826c78c15662ec6d87f491f084cd5e0aff3f0a0a14ece257b2d4e2d8  ika_protocol_test.so
```

## Checking `ika_protocol.so` against devnet

`solana program dump` returns the whole program-data account, not the ELF alone. The account is
zero-padded to its allocated size, which is 697,784 bytes today (sha256
`7671075b9de6bae87bda84a4818c9b5155f68bd5b4bf8c7a9dbdc0750169f786`). Its first 691,408 bytes are
the ELF, and the rest are zeros:

```
solana program dump -u devnet CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT dump.so
head -c 691408 dump.so | sha256sum   # equals bin/ika_protocol.so
tail -c +691409 dump.so | LC_ALL=C tr -d '\0' | wc -c   # 0
```

If the program is extended again, the account grows, and so does the padding. So compare the first
691,408 bytes, the ELF's length, not the whole dump.

## Your own program

Your own program is built with no network feature for these tests, so the
ika program it calls is the one loaded from `ika_protocol_test.so`. Build it
with `--features devnet-pre-alpha` to deploy it to devnet.
