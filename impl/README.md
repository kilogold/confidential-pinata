# confidential-pinata

Next.js app with Tailwind CSS, `@solana/kit`, and an Anchor pinata program.

## Getting Started

```shell
npm install
npm run setup   # Builds the Anchor program and generates the TypeScript client
npm run dev
```

Copy [`.env.example`](.env.example) to `.env.local` and set `ARBITER_AUTHORITY_SECRET_KEY_BASE64` before using Initialize / Attack / Close. Next.js loads that file from this directory (`impl/`), which is the project root for `app/`. Keep `.env.local` on the arbiter host only. Variables must not use a `NEXT_PUBLIC_` prefix.

That keypair is [arbiter.md](../docs/arbiter.md) **A2** and [deployment.md](../docs/deployment.md) **DEP2**, **DEP5**, **DEP6** (simplest v1: mint authority and vault authority). HP ElGamal and AES are derived from it at runtime. They are reused for every instance and Initialize. That is not game-master isolation ([arbiter.md](../docs/arbiter.md) **O1**).

Open [http://localhost:3000](http://localhost:3000), connect your wallet, and use the Game Master / Player actions.

## What's Included

- **Landing** — Game Master (Init, Close) and Player (Register, Strike) actions
- **Wallet connection** via wallet-standard with auto-discovery and dropdown UI
- **Cluster switching** — devnet, testnet, mainnet, and localnet from the header
- **Toast notifications** with explorer links for every transaction
- **Error handling** — human-readable messages for common Solana and program errors
- **Codama-generated client** — type-safe program interactions using `@solana/kit`
- **Tailwind CSS v4** with light/dark mode toggle

## Stack

| Layer          | Technology                       |
| -------------- | -------------------------------- |
| Frontend       | Next.js 16, React 19, TypeScript |
| Styling        | Tailwind CSS v4                  |
| Solana Client  | `@solana/kit`, wallet-standard   |
| Program Client | Codama-generated, `@solana/kit`  |
| Program        | Anchor (Rust)                    |

## Project Structure

```
├── app/
│   ├── components/
│   │   ├── cluster-context.tsx  # Cluster state (React context + localStorage)
│   │   ├── cluster-select.tsx   # Cluster switcher dropdown
│   │   ├── providers.tsx        # Wallet + theme providers
│   │   ├── role-section.tsx     # Game Master / Player action groups
│   │   ├── theme-toggle.tsx     # Light/dark mode toggle
│   │   └── wallet-button.tsx    # Wallet connect/disconnect dropdown
│   ├── generated/pinata/       # Codama-generated program client
│   ├── lib/
│   │   ├── wallet/             # Wallet-standard connection layer
│   │   │   ├── types.ts        # Wallet types
│   │   │   ├── standard.ts     # Wallet discovery + session creation
│   │   │   ├── signer.ts       # WalletSession → TransactionSigner
│   │   │   └── context.tsx     # WalletProvider + useWallet() hook
│   │   ├── hooks/
│   │   │   ├── use-balance.ts  # SWR-based balance fetching
│   │   │   └── use-send-transaction.ts  # Transaction send with loading state
│   │   ├── cluster.ts          # Cluster endpoints + RPC factory
│   │   ├── lamports.ts         # SOL/lamports conversion
│   │   ├── send-transaction.ts # Transaction build + sign + send pipeline
│   │   ├── errors.ts           # Transaction error parsing
│   │   └── explorer.ts         # Explorer URL builder + address helpers
│   └── page.tsx                # Main page
├── anchor/                     # Anchor workspace
│   └── programs/pinata/        # Pinata program (Rust)
└── codama.json                 # Codama client generation config
```

## Local Development

To test against a local validator instead of devnet:

1. **Start a local validator**

   ```bash
   solana-test-validator
   ```

2. **Deploy the program locally**

   ```bash
   solana config set --url localhost
   cd anchor
   anchor build --ignore-keys
   anchor deploy
   cd ..
   npm run codama:js   # Regenerate client with local program ID
   ```

3. **Switch to localnet** in the app using the cluster selector in the header.

`npm run setup` and `npm run anchor-build` pass `--ignore-keys` so Anchor keeps the program ID in `declare_id!` instead of generating a new keypair.

## Deploy

### Prerequisites

- [Rust](https://rustup.rs/)
- [Solana CLI](https://solana.com/docs/intro/installation)
- [Anchor](https://www.anchor-lang.com/docs/installation)

### Steps

1. **Configure Solana CLI for the target cluster**

   ```bash
   solana config set --url devnet
   ```

2. **Create a wallet (if needed) and fund it**

   ```bash
   solana-keygen new
   solana airdrop 2
   ```

3. **Build and deploy the program**

   ```bash
   cd anchor
   anchor build --ignore-keys
   anchor deploy
   cd ..
   ```

4. **Regenerate the client and restart**

   ```bash
   npm run setup   # Rebuilds program and regenerates client
   npm run dev
   ```

## Testing

`anchor test` starts a [Surfpool](https://docs.surfpool.run) localnet that **forks Devnet** (`online = true` in `anchor/Anchor.toml`), deploys the local pinata build, then runs the Initialize happy path in `anchor/tests/initialize.test.ts`.

That test talks to real Token-2022, the ZK ElGamal proof program, and the shared Devnet HP mint. It loads `ARBITER_AUTHORITY_SECRET_KEY_BASE64` and `HP_MINT` from `.env.local`. RPC is `ANCHOR_PROVIDER_URL` (the Surfpool localnet), not `SOLANA_RPC_URL`.

```bash
npm run anchor-test
```

Shut down any other process on port 8899 first, or run `cd anchor && anchor test --skip-local-validator` against a Devnet-fork Surfpool you already started.

## Regenerating the Client

If you modify the program, regenerate the TypeScript client:

```bash
npm run setup   # Or: npm run anchor-build && npm run codama:js
```

This uses [Codama](https://github.com/codama-idl/codama) to generate a type-safe client from the Anchor IDL.

## Learn More

- [Solana Docs](https://solana.com/docs) — core concepts and guides
- [Anchor Docs](https://www.anchor-lang.com/docs/introduction) — program development framework
- [Deploying Programs](https://solana.com/docs/programs/deploying) — deployment guide
- [@solana/kit](https://github.com/anza-xyz/kit) — Solana JavaScript SDK
- [Codama](https://github.com/codama-idl/codama) — client generation from IDL
