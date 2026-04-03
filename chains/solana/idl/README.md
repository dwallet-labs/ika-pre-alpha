# IDL

This directory holds the Codama IDL JSON file for the Ika System program.

The IDL is generated from the program source (not included in this repo). To regenerate:

```bash
# In the full ika repo:
cargo check -p ika-system-program --features idl
```

Then copy `ika_system_program.json` here.
