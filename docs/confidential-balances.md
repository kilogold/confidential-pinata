# Confidential balances

Version 1 uses Token-2022 **Confidential Balances** so HP and reward amounts stay encrypted on-chain.

## Two mints

- **HP token** — 1 token = 1 HP. The piñata’s confidential HP balance *is* its health.
- **Reward token** — any confidential-balance mint; conceptually a stablecoin. Locked at Initialize; only the killing player receives it.

**Register** exists so each player can set up a confidential-enabled token account for the reward mint before a payout can land.

## What observers can see

```mermaid
flowchart TB
  subgraph public [Public]
    accounts[Accounts exist]
    attacks[Someone attacked]
    solFee[SOL fee and pile size]
    died[Piñata died on this strike]
  end
  subgraph hidden [Encrypted]
    hp[Remaining HP]
    reward[Reward amount]
    priorHp["Prior HP beyond at least 1"]
  end
  public -.->|"cannot infer"| hidden
```

Zero remaining HP is not a public field. The **ElGamal proof program** attests that the remaining HP ciphertext encrypts zero. Observers learn the piñata died on this strike; they do not learn what HP was before (beyond “at least 1”).

## Network

Version 1 targets a test network. Confidential Balances need a ZK-capable cluster, which may not be generic public devnet.
