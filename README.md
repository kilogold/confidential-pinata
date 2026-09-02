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

- Unknown HP, unknown reward, fixed SOL strike fee — **unknown to players and spectators**, not to the game master
- Game master is the house: they set HP and reward at Initialize, so they know remaining HP (`initial −` public strike count) and the reward size
- **SAS unique-person identity.** Initialize, Register, and Attack require a Solana Attestation Service attestation ([attest.solana.com](https://attest.solana.com/)). The issuer’s KYC (or equivalent) is **1 human ↔ 1 attestation**. The program records the GM’s person id at Initialize and **rejects Attack** if the attacker’s person id is the GM’s. Last-hit snipe via a second wallet is closed **on-chain**, conditional on issuer uniqueness and a comparable person-id in the schema.
- v1 **trusts the SAS issuer** not to attest the same person on two wallets. SAS binds a claim to an account; person uniqueness is issuer policy plus an on-chain person-id check, not a property of SAS by itself.
- **1 HP** damage per strike
- **Unlimited Attacks** per attested player on a live piñata. One human can keep striking. This is purchase-under-uncertainty, not a one-hit raffle. Strike count is not distinct-player count.
- **Player reason to play is GM reputation across sessions**, not on-chain +EV. The house still chooses `HP`, fee, and reward. Players learn a GM’s **HP style** over time (initial HP becomes public at game-over via strike count). **Reward stays hidden after the win** — only the GM and the killer know the amount. Reward-reputation is rumor, not public history. Trash reward stays opaque.
- Two confidential token types: HP (1 token = 1 HP) and reward (any confidential-balance mint; conceptually a stablecoin)
- **Many live piñatas**; each has its own PDA set and SOL fee pile
- Strike fees go to **that piñata’s PDA**, not a global pot
- Zero remaining HP is attested by the **ElGamal proof program** (no public HP number)
- Instructions: **Initialize**, **Register**, **Attack**, **Close**
- The killing **Attack** settles atomically: game master gets the SOL pile; killer gets the confidential reward
- **Attack is not a player-only transaction.** v1: the GM’s confidential keys sit on a **relay** that supplies proofs on every strike, including the kill — so the GM does not manually intervene per Attack. **Dealer censorship is accepted in v1** (the relay can refuse a strike and pick a winner). Unique-person only stops the GM’s own id from receiving the reward. The relay is still the house: hot keys, house liveness. A PDA cannot hold the vault ElGamal secret.
- **Later: independent arbiter.** The GM must delegate all confidential operations and must not be able to withhold a specific player’s proof. Future tweaks may include a confidential range of strike damage per player (would replace v1’s fixed 1 HP — not decided).
- After game-over: only **Close** (tear down PDAs, return rent) or **Initialize** (new session on the same piñata)

## Still open

- **Which SAS credential/schema**, and which attestation field is the person id the program compares.
- Whether a third party holds auditor keys (optional extra decryptor — not how the GM knows amounts)
- Who may call **Close**
- Who receives returned rent on **Close**
