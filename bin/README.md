# The ika program, compiled

The ika program ships here as compiled SBPF v3 programs only.

| File | What it is |
| --- | --- |
| `ika_protocol.so` | The program the Solana devnet pre-alpha runs at `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT`, byte for byte. `solana program dump -u devnet CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT` gives the same file. |
| `ika_protocol_test.so` | The program built for the local development address, `ika_protocol_program_id::ID` with no network feature. The LiteSVM tests load it there (`crates/ika-dwallet-litesvm-test`). |

SHA-256:

```
312954f5e71fa54dd87018a77474106dcda83bc87585a69e5ed8bfea2e46d6da  ika_protocol.so
57d0eaf48c35fa13accc38c616d75e48ffaae453be13aac8149cd35f91fbffbd  ika_protocol_test.so
```

Your own program is built with no network feature for these tests, so the
ika program it calls is the one loaded from `ika_protocol_test.so`. Build it
with `--features devnet-pre-alpha` to deploy it to devnet.
