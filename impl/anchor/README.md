# Anchor Pinata Program

Pinata program (ASCII crate name `pinata`) built with [Anchor](https://www.anchor-lang.com/). The program ID is in `declare_id!` in `programs/pinata/src/lib.rs` and under `[programs.devnet]` in `Anchor.toml`.

Design: [program.md](../../docs/program.md). This crate implements **Initialize** (F1). Register, Attack, and Close are not in this crate yet.

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

## Initialize

`initialize` starts a session (or a new session after Game Over on the same PDAs). The caller is the GM. The arbiter must sign as HP mint authority. Instruction layouts live in the program; they are still open in the design docs.

PDA seeds (UTF-8 `session_id`, max 24 bytes):

- `["session", session_id]`
- `["hp_vault", session_id]`
- `["reward_vault", session_id]`
- `["sol_pile", session_id]`

Initialize CPIs `ConfidentialMint` then `ApplyPendingBalance`. The arbiter signs as HP mint authority and HP vault authority (not a PDA). `ApplyPendingBalance` takes the arbiter-supplied decryptable available balance (vault AES) so minted HP is spendable.

## Testing

Tests use [LiteSVM](https://github.com/LiteSVM/litesvm). They cover Initialize gates (session_id, live already-exists, Game Over empty pots / zero-proof, arbiter signer, amounts). Confidential mint happy path needs a ZK-enabled runtime and is not in this suite.

```bash
# from impl/anchor (Anchor.toml scripts.test = cargo test)
anchor test --skip-deploy
```
