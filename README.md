# Confidential Piñata

An on-chain piñata on Solana whose remaining HP and reward size are hidden. Players pay a fixed SOL fee to strike. The blow that takes HP to zero wins the locked confidential token reward.

This repo holds **conceptual design notes** for a Token-2022 Confidential Balances game. It is **not** an implemented program yet.

**Cluster:** Solana test network (devnet-oriented). Confidential Balances need a ZK-capable cluster.

## Docs

Read in this order:

1. [Game](docs/game.md) — loop, roles, why hidden amounts matter
2. [Confidential balances](docs/confidential-balances.md) — HP and reward tokens, what observers can see
3. [Program](docs/program.md) — instructions, per-piñata PDAs, kill settlement

See also the [docs catalog](docs/README.md).

## Decided in v1

- Unknown HP, unknown reward, fixed SOL strike fee
- **1 HP** damage per strike
- Two confidential token types: HP (1 token = 1 HP) and reward (any confidential-balance mint; conceptually a stablecoin)
- **Many live piñatas**; each has its own PDA set and SOL fee pile
- Strike fees go to **that piñata’s PDA**, not a global pot
- Zero remaining HP is attested by the **ElGamal proof program** (no public HP number)
- Instructions: **Initialize**, **Register**, **Attack**, **Close**
- The killing **Attack** settles atomically: game master gets the SOL pile; killer gets the confidential reward
- After game-over: only **Close** (tear down PDAs, return rent) or **Initialize** (new session on the same piñata)

## Still open

- Whether the game master can decrypt HP or reward during play (auditor keys)
- Who may call **Close**
- Who receives returned rent on **Close**
