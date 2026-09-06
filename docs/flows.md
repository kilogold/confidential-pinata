# Flows

Sequences among the participants in [deployment.md](deployment.md). On-chain: [program.md](program.md). Arbiter: [arbiter.md](arbiter.md).

Instruction layouts, account metas, RPC shapes, and proof byte formats are out of scope.

**F0** applies to every flow. Initialize = **F1**. Attack = **F2**. Close wire details are still **O2**.

## F0. Wallet connect and send

1. Wallets MUST connect to the arbiter webapp with a Solana wallet adapter.
2. The webapp MUST supply the transaction(s). Those transactions MUST already be assembled by the arbiter and MUST already be partial-signed by it before the wallet sees them. The connected wallet MUST sign as fee payer (GM pays Initialize rent and Close; player pays Attack, including the strike fee). Send MUST use that wallet’s own RPC, not a webapp-submitted send on their behalf. The wallet MUST NOT be given an unsigned Attack (or Initialize/Close) to assemble.
3. Mint-authority partial-sign = **DEP5**. Vault-authority partial-sign (`ConfidentialBurn`, `ApplyPendingBalance`, vault close) = **DEP6**. Attack also requires burn proofs only the backend can produce; a player MUST NOT assemble a competing Attack from an unsigned payload.

## F1. Initialize

Starts a session (also a new session after game-over; **D4**).

GM MUST supply the public reward and the strike fee. GM MUST NOT choose HP (**D2**, **A3**). Using the frontend does not count as reading the arbiter (**DEP3**). Initialize requires a SAS attestation ([game.md](game.md)); credential / person-id field still open there.

| Who | What |
| --- | --- |
| GM | Public reward, strike fee, fee payer (PDA rent). Completes the signature. |
| Arbiter backend | Jupiter price, hidden offset, HP, `ConfidentialMint` proofs, mint-authority and vault-authority partial-sign, vault and supply keys. |
| Piñata program | Initialize (CPI `ConfidentialMint`). Immediately after: `ApplyPendingBalance` as arbiter vault authority (no PDA signer). |

| Instruction | Effect | Who authorizes |
| --- | --- | --- |
| `ConfidentialMint` (CPI during Initialize) | Encrypted HP into this vault’s **pending** on the shared mint. | HP mint authority |
| `ApplyPendingBalance` (next instruction) | Pending → **available**. Required before any Attack burn. | HP vault authority (not a PDA) |

```mermaid
sequenceDiagram
  autonumber
  actor GM as GM wallet
  participant FE as Arbiter frontend
  participant BE as Arbiter backend
  participant Prog as Piñata program
  participant RT as Solana runtime

  GM->>FE: connect (wallet adapter)
  GM->>FE: request Initialize
  FE->>BE: Initialize request
  Note over BE: Price (A4). Offset. HP (A3).<br/>Keys stay on backend (A2, DEP2, DEP5, DEP6).
  BE->>BE: generate ElGamal ZK proofs
  BE->>BE: build Initialize plus ApplyPendingBalance
  BE->>BE: partial-sign mint authority and vault authority
  BE-->>FE: partially signed transaction
  FE-->>GM: transaction to sign (GM is fee payer)
  Note over FE,GM: MUST NOT include vault keys, supply keys, HP, offset, or range (A6, DEP3).
  GM->>Prog: complete signature; send via wallet RPC
  Prog->>RT: allocate instance PDAs
  Note over Prog: CPI ConfidentialMint (pending).<br/>ApplyPendingBalance (available; arbiter vault authority).<br/>Live. Reward locked. Shared mint is not created per instance.
```

**MUST**

1. **Connect** to the arbiter webapp (**F0**).
2. **Request** Initialize from the frontend (public reward and strike fee). Frontend MUST forward to the backend.
3. **Proofs.** Backend MUST perform **A3** and MUST generate the ElGamal ZK proofs for the confidential HP mint. Proof generation MUST stay on the backend (**A2**).
4. **Build.** Backend MUST assemble Initialize (CPI `ConfidentialMint`) and MUST put `ApplyPendingBalance` immediately after. Arbiter MUST partial-sign that apply as vault authority (**DEP6**). MUST NOT PDA-sign it. MUST partial-sign as mint authority (`ConfidentialMint`, **DEP5**) and MUST supply the new decryptable available balance for `ApplyPendingBalance` (vault AES). Frontend MUST return that transaction for **F0**.
5. **Sign and send.** Returned transaction and any frontend payload MUST NOT include vault ElGamal secrets, supply ElGamal or AES secrets, the HP draw, `offset`, or the offset range. GM MUST complete as fee payer and send via wallet RPC (**F0**).
6. **On chain.** Program MUST initialize the instance. Runtime MUST allocate that instance’s PDAs (including the HP vault token account). Initialize MUST confidential-mint HP into that vault’s pending on the shared mint. `ApplyPendingBalance` MUST follow immediately, authorized by the arbiter as vault authority. Session live; public reward locked.

## F2. Attack

Registered player strikes. On-chain result: **D3**. Player MUST already be registered. GM person id MUST NOT Attack ([game.md](game.md)). SAS attestation required; credential / person-id field still open there. Attack deals 1 HP.

| Instruction | Effect | Who authorizes |
| --- | --- | --- |
| `ConfidentialBurn` | Homomorphic −1 on this vault. **This is the hit.** CPI from Attack. | Vault authority + burn proofs |
| `ApplyPendingBurn` | Shared mint `pending_burn` → encrypted supply. **Not** the hit. | Mint authority |
| `UpdateDecryptableSupply` | Mint AES decryptable supply after `ApplyPendingBurn`. **Not** the hit. | Mint authority + supply AES |

Kill is not “vault bytes look like zero.” Kill is `VerifyZeroCiphertext` on this Attack, CPI-verified and byte-bound to the post-burn vault (**D3**).

| Branch | Arbiter puts on Attack | On chain |
| --- | --- | --- |
| Live | Burn proofs only. MUST NOT include `VerifyZeroCiphertext`. | Stay live. No payout. |
| Kill | Burn proofs plus `VerifyZeroCiphertext` for the post-burn `available_balance` blob (not a fresh `Encrypt(0)`). | CPI verify, bind to vault, pay pile and reward or fail the whole Attack. |

Omitting the kill proof when leftover HP is actually 0 is **A7**. Only a malicious or exploited arbiter can land it; a player cannot (**F0**). Conforming arbiter MUST NOT assemble it (**A5**).

```mermaid
sequenceDiagram
  autonumber
  actor Player as Player wallet
  participant FE as Arbiter frontend
  participant BE as Arbiter backend
  participant Prog as Piñata program

  Player->>FE: connect (wallet adapter)
  Player->>FE: request Attack
  FE->>BE: Attack request
  Note over BE: Keys stay on backend.<br/>MUST NOT reveal HP, offset, or range (A5).
  BE->>BE: generate ConfidentialBurn proofs for HP minus 1
  alt remaining HP will be zero
    BE->>BE: also VerifyZeroCiphertext for post-burn vault blob (A5)
  else remaining HP will not be zero
    Note over BE: MUST NOT include VerifyZeroCiphertext
  end
  BE->>BE: build Attack sequence
  BE->>BE: partial-sign burn as vault authority; supply ixs as mint authority
  BE-->>FE: transaction(s)
  FE-->>Player: to sign (player is fee payer)
  Note over FE,Player: MUST NOT include vault keys, supply keys, HP, offset, or range.
  loop each transaction in the sequence
    Player->>Prog: complete signature; send via wallet RPC
  end
  Note over Prog: ConfidentialBurn: HP minus 1. Strike SOL to pile.<br/>ApplyPendingBurn then UpdateDecryptableSupply (supply only).
  alt no VerifyZeroCiphertext in Attack
    Note over Prog: Stay live (D3). Only malicious/exploited arbiter omits (A7).
  else VerifyZeroCiphertext present
    Prog->>Prog: CPI verify, byte-bind to post-burn vault
    alt fail or mismatch
      Note over Prog: Whole Attack fails. Burn undone.
    else match
      Note over Prog: Game over. GM gets SOL pile. Killer gets public reward (D3).
    end
  end
```

Proof setup MAY precede Attack if proofs do not fit in one legacy/v0 transaction. Kill settlement MUST stay atomic inside Attack (**D3**).

**MUST**

1. **Connect** (**F0**).
2. **Request** Attack from the frontend. Frontend MUST forward to the backend.
3. **Proofs.** Backend MUST generate Token-2022 proofs for homomorphic −1. If leftover HP is 0, MUST attach `VerifyZeroCiphertext` for the post-burn vault `available_balance` blob (**A5**). If not, MUST NOT. Proof generation MUST stay on the backend (**A2**).
4. **Build.** Proof setup as needed → Attack with `ConfidentialBurn` CPI (HP − 1; arbiter vault-authority signature, **DEP6**) and, on a kill, `VerifyZeroCiphertext` → `ApplyPendingBurn` immediately after → `UpdateDecryptableSupply`. Arbiter MUST partial-sign the two supply ixs as mint authority (**DEP5**).
5. **Fit.** If proofs do not fit in one legacy/v0 transaction, the webapp MUST return a sequence and the player MUST sign each. Earlier transactions are proof setup only. When Solana Transaction v1 (SIMD-0385, 4096-byte transactions) is usable on the target cluster, the webapp SHOULD collapse to one transaction and one player signature.
6. **Sign and send.** Frontend MUST return the transaction(s). Player MUST complete each as fee payer (strike fee included) via wallet RPC (**F0**). Returned payloads MUST NOT include vault ElGamal secrets, supply ElGamal or AES secrets, remaining HP, the HP draw, `offset`, or the offset range. Arbiter MUST NOT expose per-strike refusal to the GM (**A5**).
7. **On chain.** Program MUST debit one HP (`ConfidentialBurn`) and credit the strike fee to the instance SOL pile. Live versus kill MUST follow **D3**.

## Decided

Normative language follows RFC 2119. **F0** applies to every flow. **F1** and **F2** above are the Initialize and Attack specifications.

## Still open

### O1. Initialize wire details

`ApplyPendingBalance` immediately after `ConfidentialMint` is specified in **F1**. HP ElGamal, HP AES, mint authority, and vault authority are reused (**A2**); vault and supply MUST share that ElGamal pubkey and AES, derived from the env authority keypair. Still unspecified: which ElGamal proof kinds are attached at Initialize; other dependent instructions besides that pair (for example account configure).

### O2. Close wire details

Close is arbiter-constructed (**DEP4**, **D4**). The shared HP mint MUST NOT be closed with the instance (**DEP6**). Unspecified: the exact Token-2022 close and leftover-zero proof instructions besides `VerifyZeroCiphertext` bound to the HP vault; Register/Close sequence diagrams.
