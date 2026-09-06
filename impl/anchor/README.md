# Anchor Pinata Program

Pinata program (ASCII crate name `pinata`) built with [Anchor](https://www.anchor-lang.com/). The program ID is in `declare_id!` in `programs/pinata/src/lib.rs` and under `[programs.devnet]` in `Anchor.toml`.

Design: [program.md](../../docs/program.md). This crate is leftover scaffold (deposit/withdraw), not the v1 instruction set yet.

## Deploy

```bash
# Build without generating a new program keypair
anchor build --ignore-keys

# Get cluster SOL for deployment (~2 SOL needed)
solana airdrop 2 --url devnet

# Deploy
anchor deploy --provider.cluster devnet
```

Then regenerate the TypeScript client:

```bash
cd ..
npm run codama:js
```

This updates the generated client in `app/generated/pinata/`.

## Program Overview

The current scaffold allows users to:

- **Deposit**: Send SOL to a personal vault PDA (Program Derived Address)
- **Withdraw**: Retrieve all SOL from your vault

Each user gets their own vault derived from their wallet address.

## Testing

Run the Anchor tests:

```bash
anchor test --skip-deploy
```
