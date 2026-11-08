# The ika program, compiled

The ika program ships here as compiled SBPF v3 programs only.

| File | What it is |
| --- | --- |
| `ika_protocol.so` | The program the Solana devnet pre-alpha runs at `8siGnE3tCZbu4LTuX8QoBPErvWeGBF4pRSJDnaGdHyQv`: 733,040 bytes. It was built with `cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha`. |
| `ika_protocol_test.so` | The program built for the local development address, `ika_protocol_program_id::ID` with no network feature: `cargo build-sbf --tools-version v1.54 --arch v3`, on macOS arm64. The LiteSVM tests load it there (`crates/ika-dwallet-litesvm-test`). |

SHA-256:

```
c4d623e7a6fd0671b36b733105d978a92d3e26bcab205ca0330f04ba25349918  ika_protocol.so
e604de2b5d40754297741e5cd82ecbb3cffc1b84f446808b15329a921e337e13  ika_protocol_test.so
```

## Checking `ika_protocol.so` against devnet

`solana program dump` returns the whole program-data account, not the ELF alone. Today the account
is exactly the ELF's size, so the dump equals `ika_protocol.so`:

```
solana program dump -u devnet 8siGnE3tCZbu4LTuX8QoBPErvWeGBF4pRSJDnaGdHyQv dump.so
head -c 733040 dump.so | sha256sum   # equals bin/ika_protocol.so
tail -c +733041 dump.so | LC_ALL=C tr -d '\0' | wc -c   # 0
```

If the program is extended, the account grows and the extra bytes are zeros. So compare the first
733,040 bytes, the ELF's length, not the whole dump.

## Your own program

Your own program is built with no network feature for these tests, so the
ika program it calls is the one loaded from `ika_protocol_test.so`. Build it
with `--features devnet-pre-alpha` to deploy it to devnet.
