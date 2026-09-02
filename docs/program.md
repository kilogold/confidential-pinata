# Program

Rules engine over confidential HP and reward. **Many instances:** each piñata is its own PDA set. Instructions always target one piñata.

## Per-piñata accounts

```mermaid
flowchart TB
  pinata[Piñata instance]
  pinata --> state[State PDA]
  pinata --> hpVault[HP vault]
  pinata --> rewardVault[Reward vault]
  pinata --> solPile[SOL fee pile]
```

## Instructions

- **Initialize** — game master locks HP amount and confidential reward for this piñata. Also starts a **new session** after game-over. Not valid while live.
- **Register** — admit a player; set up their reward token account. Only while live.
- **Attack** — pay fixed SOL into this piñata’s pile; HP − 1; evaluate live vs kill. Only while live.
- **Close** — tear down this piñata’s PDAs; return rent SOL. Only after game-over.

## Killing Attack

When remaining HP is proven zero (ElGamal proof program), the same **Attack** enters game-over and settles atomically:

```mermaid
flowchart LR
  attack[Attack HP minus 1]
  attack --> proof{"Remaining HP ciphertext is zero?"}
  proof -->|no| live[Stay live]
  proof -->|yes| settle[Game over]
  settle --> gm[Game master gets SOL pile]
  settle --> killer[Killer gets confidential reward]
```

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Uninitialized
  Uninitialized --> Live: Initialize
  Live --> Live: Register
  Live --> Live: Attack HP above zero
  Live --> GameOver: Killing Attack
  GameOver --> Closed: Close
  GameOver --> Live: Initialize
  Closed --> [*]
```

After game-over, only **Close** or **Initialize**. No instruction data schemas in this conceptual pass.
