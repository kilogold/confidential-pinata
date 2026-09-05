# Confidential Piñata

A **glass piñata** on Solana: the reward is public; remaining HP is not. Players pay a fixed SOL fee to strike. Zero leftover HP is the kill: that blow wins the locked token reward. On chain the program pays when Attack bound-proves that leftover ([docs/program.md](docs/program.md) **D3**). The instruction can theoretically accept a last-HP burn without that proof; only a malicious or exploited arbiter can submit it ([docs/arbiter.md](docs/arbiter.md) **A7**). The arbiter is assumed trustworthy and MUST NOT assemble that Attack ([docs/arbiter.md](docs/arbiter.md) **A5**).

This repo holds **conceptual design notes**. It is **not** an implemented program yet.

**Cluster:** Solana test network (devnet-oriented). Confidential Balances need a ZK-capable cluster.

## Docs

v1 decisions live in these files (Decided / Still open in each). Read in this order:

1. [Game](docs/game.md) — loop, roles, identity, why HP is hidden
2. [Confidential balances](docs/confidential-balances.md) — HP encrypted, reward in the clear
3. [Deployment](docs/deployment.md) — wallets use the arbiter webapp (program client inside)
4. [Program](docs/program.md) — instructions
5. [Arbiter](docs/arbiter.md) — webapp: price, HP draw, proofs
6. [Flows](docs/flows.md) — sequence diagrams (Initialize, Attack)

Catalog: [docs/README.md](docs/README.md).
