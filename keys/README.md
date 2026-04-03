# Keys

Solana keypairs for pre-alpha deployments.

## Generating a devnet keypair

```bash
solana-keygen new --outfile keys/devnet-pre-alpha-dwallet-keypair.json --no-bip39-passphrase
```

The `.gitignore` excludes `*.json` files in this directory to prevent accidental key commits.
