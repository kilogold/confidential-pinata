# Deployment

Who runs what, and where instance state lives. Behavior: [program.md](program.md), [arbiter.md](arbiter.md). Sequences: [flows.md](flows.md).

Frontend vs backend process split, hosting, and RPC shapes are unspecified. v1 key storage is [arbiter.md](arbiter.md) **A2**.

Jupiter Tokens API v2 (**A4**) is an **external dependency of the arbiter**, not a fifth deployed component.

## Layout

Wallets talk to the arbiter webapp. The Piñata program client lives **inside** that webapp. The GM wallet MUST NOT read the backend (policy; **A6**, **O1**).

```mermaid
flowchart TB
  gmWallet[GM wallet]
  playerWallet[Player wallet]

  subgraph arbiter [Arbiter webapp]
    client[Piñata program client]
  end

  subgraph solana [Solana]
    program[Piñata program]
    hpMint[Shared HP mint]
    subgraph pdas [Per-piñata PDAs]
      state[State]
      hpVault[HP vault token account]
      rewardVault[Reward vault]
      solPile[SOL fee pile]
    end
    program --- pdas
    hpMint --- hpVault
  end

  gmWallet --> arbiter
  playerWallet --> arbiter
  client --> program
  gmWallet -.->|"MUST NOT read backend"| arbiter
```

**Figure 1.** One shared HP mint. Each instance: PDA-addressed HP token account (arbiter **authority**). Reward vault and SOL pile stay program-controlled PDAs.

## Participants

| Participant | Where | Role |
| --- | --- | --- |
| **GM wallet** | Client | Connects to the webapp. Completes Initialize and Close as fee payer; pays PDA rent. MUST NOT hold live HP ElGamal or AES keys, HP mint authority, or HP vault authority. |
| **Player wallet** | Client | Connects to the webapp. Signs Register and Attack. Pays the strike fee. |
| **Arbiter webapp** | Off-chain (frontend, backend, and program client as **one** participant) | Primary client. Prices the reward, draws HP, holds keys in the backend, attaches HP proofs, partial-signs Token-2022 HP instructions, builds program transactions. |
| **Piñata program** | Solana | Instructions and settlement. Not a user-facing client. |

Isolation (**DEP3**, **A6**) applies to **backend secrets**, not to using the frontend to sign Initialize or Close.

## Names: owner vs authority

Solana uses “owner” for two different pubkeys. This design uses:

| Word | Meaning |
| --- | --- |
| **Owner** | Runtime program id that may modify the account’s **data**. HP vault owner = Token-2022. |
| **Authority** | Token-2022 pubkey that signs burns, pending-balance apply, confidential configure, and close of that token account (layout field still named `owner`). |
| **Mint authority** | Separate Token-2022 role on the **mint** (`ConfidentialMint`, `ApplyPendingBurn`, `UpdateDecryptableSupply`). |

```mermaid
flowchart LR
  subgraph vault [HP vault token account]
    addr[Address: instance PDA]
    own[Owner: Token-2022]
    auth[Authority: arbiter key]
  end
  subgraph mint [Shared HP mint]
    ma[Mint authority: arbiter key]
  end
  ma -->|"ConfidentialMint"| vault
  auth -->|"ConfidentialBurn / ApplyPendingBalance / close"| vault
```

One authority + one mint ⇒ one **ATA**. That cannot isolate instances, so HP vaults are **not** ATAs.

## Decided

Normative language follows RFC 2119.

### DEP1. Components

A v1 deployment MUST include a GM wallet, one or more player wallets, one arbiter webapp, the Piñata program on a Solana cluster, and one shared HP mint (**DEP6**). Each live piñata MUST have its own PDA set: state, HP vault token account, reward vault, and SOL fee pile.

### DEP2. Arbiter is the webapp

The arbiter MUST be one webapp participant: frontend, backend, and the Piñata program client as a single deployment abstraction, not a separate extra relay and not a second named component. HP ElGamal and AES (vault and supply), the HP mint authority, and the HP vault authority MUST live in that webapp’s backend, not in the frontend, not in a PDA, and not on the GM wallet after Initialize. Those secrets MUST be reused (**A2**). v1 MUST keep the arbiter Solana authority keypair in a host-local env file readable by the arbiter backend. HP ElGamal and AES MUST be derived from that keypair at runtime. They MUST NOT be stored as separate env values.

### DEP3. Isolation on the wire

The GM wallet MUST NOT have operational access to the arbiter webapp backend (keys, HP draw, per-strike refuse). Using the frontend to sign Initialize or Close does not count as reading the arbiter. Enforcement is [arbiter.md](arbiter.md) **O1**.

### DEP4. Program client is in the webapp

The Piñata program client MUST live in the arbiter webapp. GM and player wallets MUST use that webapp as their primary interaction surface. They MUST NOT be assumed to hold a separate program client that can complete Initialize, Attack, or Close.

Initialize, Attack, and Close require ZK proofs generated from backend-held vault ElGamal keys (**A1**, **A2**, **A5**). Close MUST be arbiter-constructed: after game-over the HP vault still holds an encrypt(0) leftover, not empty bytes, and Token-2022 will not close that account without a leftover-zero proof. The arbiter backend MUST attach that proof and MUST partial-sign as HP vault authority (**DEP6**); the GM wallet MUST complete the transaction as fee payer ([flows.md](flows.md) **F0**) and MUST NOT receive vault ElGamal secrets. Close MUST NOT close the shared HP mint. Register does not need vault secrets; v1 still routes it through the same webapp so there is one client, not two.

Confidential HP Token-2022 roles are **DEP6**. Attack MUST still CPI `ConfidentialBurn` so the hit and the strike fee stay one instruction (**D3**); the vault-authority signer on that CPI is the arbiter, not a PDA. Only the instance HP vault’s confidential balance is that piñata; burning from an unrelated token account is irrelevant. A player MUST NOT assemble Attack.

### DEP5. HP mint authority is the arbiter

The HP mint authority MUST be a key held in the arbiter webapp backend. The backend MUST partial-sign `ConfidentialMint` (Initialize) and, on the Attack sequence, `ApplyPendingBurn` then `UpdateDecryptableSupply`. The GM and player wallets MUST NOT hold that key. This key MAY be the same keypair as HP vault authority (**DEP6**).

### DEP6. Shared HP mint; vault authority is the arbiter

**Names.** On a Solana account, **owner** is the program id that may modify that account’s data. For an HP vault, that owner is Token-2022. **Authority** is the Token-2022 pubkey that signs burns, pending-balance apply, confidential configure, and close of that token account (layout field `owner`). This document uses those two words that way. Mint authority is a different Token-2022 role on the mint.

**Mint.** v1 MUST use one shared HP mint for all piñata instances. The mint is not a per-instance PDA. Close of one instance MUST NOT close that mint.

**Vaults.** Each instance MUST have its own HP token account. That account MUST NOT be an ATA of the arbiter for the shared mint. The HP vault **address** MUST be an instance PDA so the account is locatable. Token-2022 is the runtime owner. The HP vault **authority** MUST be an arbiter backend key, not a PDA. v1 MUST NOT PDA-sign Token-2022 confidential HP instructions. Initialize MAY still allocate that PDA (create-account); that is not a confidential-HP signer.

**Same key.** HP mint authority (**DEP5**) and HP vault authority MAY be the same arbiter keypair. Simplest v1 is one key.

**Reward and SOL.** The public reward vault and the SOL pile MUST remain instance PDAs whose spending path is the Piñata program. They MUST NOT use the arbiter as token or SOL authority. The arbiter is assumed trustworthy and secure for exclusive HP generation and signing.
