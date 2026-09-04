# Docs

Conceptual design for **Confidential Piñata**. Technical specs (accounts, proofs, clients) will land here later.

v1 **Decided** and **Still open** sit in the files below, not in the project README.

## Reading order

1. [Game](game.md) — player-facing loop and roles
2. [Confidential balances](confidential-balances.md) — HP hidden, reward public
3. [Deployment](deployment.md) — wallets use the arbiter webapp (program client inside)
4. [Program](program.md) — on-chain instructions
5. [Arbiter](arbiter.md) — webapp: price, HP draw, proofs, isolation
6. [Flows](flows.md) — sequence diagrams (Initialize, Attack)

| Doc | What it covers |
| --- | --- |
| [game.md](game.md) | Session loop, roles, identity, reputation; SAS still open |
| [confidential-balances.md](confidential-balances.md) | HP confidential, reward public, visibility split; auditor still open |
| [deployment.md](deployment.md) | Figure 1; DEP1–DEP5 |
| [program.md](program.md) | Initialize, Register, Attack, Close; D1–D4; kill is bound `VerifyZeroCiphertext` on Attack |
| [arbiter.md](arbiter.md) | Jupiter price, HP formula, vault and supply keys, proofs; A1–A8; endgame lock is A7; O1 |
| [flows.md](flows.md) | Initialize (`ConfidentialMint` then `ApplyPendingBalance`) and Attack (live vs kill by zero-proof presence); F0–F2; remaining Initialize wire details still open |

Back to the [project README](../README.md).
