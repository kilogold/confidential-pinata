# Confidential Piñata

A **glass piñata** on Solana: the reward is public; remaining HP is not. Players pay a fixed SOL fee to strike. The blow that takes HP to zero wins the locked token reward.

This repo holds **conceptual design notes**. It is **not** an implemented program yet.

**Cluster:** Solana test network (devnet-oriented). Confidential Balances need a ZK-capable cluster.

## Docs

v1 decisions live in these files (Decided / Still open in each). Read in this order:

1. [Game](docs/game.md) — loop, roles, identity, why HP is hidden
2. [Confidential balances](docs/confidential-balances.md) — HP encrypted, reward in the clear
3. [Deployment](docs/deployment.md) — wallets, arbiter server, program and PDAs
4. [Program](docs/program.md) — instructions
5. [Arbiter](docs/arbiter.md) — relay: price, HP draw, proofs
6. [Flows](docs/flows.md) — participant interactions (stub)

Catalog: [docs/README.md](docs/README.md).
