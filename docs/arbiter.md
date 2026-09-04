# Arbiter

Off-chain webapp that prices the reward, draws HP, holds vault ElGamal keys and HP mint supply keys, attaches confidential HP proofs, and hosts the Piñata program client. Deployment is in [deployment.md](deployment.md). On-chain rules live in [program.md](program.md).

v1 does **not** add a second extra process. The **arbiter webapp is the arbiter** ([deployment.md](deployment.md) **DEP2**).

## Decided

Normative language follows RFC 2119. These decisions apply to the v1 arbiter. They do not specify RPC shapes, key-storage formats, or host configuration.

### A1. Topology

The v1 arbiter MUST be the arbiter webapp described in [deployment.md](deployment.md) (frontend, backend, and Piñata program client as one participant), not a second extra process. That webapp is the primary client for GM and player wallets ([deployment.md](deployment.md) **DEP4**). Attack is not a player-only transaction: the arbiter MUST participate in every Attack that mutates confidential HP. Vault ElGamal keys, HP mint supply keys, and the HP mint authority MUST live in the backend ([deployment.md](deployment.md) **DEP2**, **DEP5**).

### A2. Keys and HP plaintext

These MUST live only in the arbiter webapp’s backend ([deployment.md](deployment.md) **DEP2**, **DEP5**):

- HP vault ElGamal keys (account encryption for the instance HP vault)
- HP mint **supply** ElGamal keypair and supply AES key (`ConfidentialMintBurn` encrypted / decryptable supply; distinct from vault keys)
- HP mint authority
- the HP draw and proof generation

A PDA MUST NOT hold vault ElGamal secrets, supply ElGamal or AES secrets, or the HP mint authority. After Initialize, those live keys MUST NOT remain on the game master’s workstation or in the frontend.

### A3. Initialize: price, offset, mint

At Initialize the arbiter MUST:

1. Price the locked public reward in SOL (**A4**).
2. Set \(\mathrm{HP} = \lfloor \mathrm{reward\_in\_SOL} / \mathrm{strike\_fee\_SOL} \rfloor + \mathrm{offset}\).
3. Confidential-mint that HP into the instance HP vault (`ConfidentialMint`, CPI during Initialize) so that public deposit amounts and public mint supply do not reveal HP. `ConfidentialMint` credits the vault’s **pending** confidential balance. The Initialize transaction MUST `ApplyPendingBalance` immediately after that mint so the minted HP is **available** to burn ([flows.md](flows.md) **F1**).

`offset` MUST be an integer \(\geq 0\) (zero is allowed). The closed interval from which `offset` is drawn MUST be known only to the arbiter. Resulting HP MUST be at least 1; Initialize MUST fail otherwise. The game master MUST NOT choose HP.

### A4. Jupiter price

The arbiter MUST price the reward using Jupiter Tokens API v2 as documented at [verified.jup.ag/apis](https://verified.jup.ag/apis): `GET https://api.jup.ag/tokens/v2/search?query=<mint>`. It MUST read `usdPrice` for the reward mint and for wrapped SOL (`So11111111111111111111111111111111111111112`), and MUST compute

\[
\mathrm{reward\_in\_SOL} = (\mathrm{reward\_ui\_amount} \times \mathrm{reward\_usdPrice}) / \mathrm{sol\_usdPrice}
\]

If the mint is absent from the response or `usdPrice` is null, the arbiter MUST treat **1 token = 1 USD** and MUST still convert USD to SOL using Jupiter’s SOL `usdPrice`.

Participants MAY estimate a floor from public Jupiter quotes. They MUST NOT be assumed to know the arbiter’s quote. Price, offset range, and the draw are trusted to the arbiter in v1.

### A5. Attack proofs

The arbiter MUST attach the Token-2022 proofs that `ConfidentialBurn` requires for a homomorphic −1 on the HP vault, for every valid Attack. Immediately after that burn, the Attack sequence MUST include `ApplyPendingBurn` then `UpdateDecryptableSupply`; the arbiter MUST partial-sign both as HP mint authority ([deployment.md](deployment.md) **DEP5**). `ApplyPendingBurn` folds mint `pending_burn` into encrypted supply and MUST NOT be treated as the HP decrement. `UpdateDecryptableSupply` refreshes the mint’s AES decryptable supply (`ApplyPendingBurn` does not). The public reward transfer on a kill MUST NOT require confidential reward proofs (see [program.md](program.md) **D3**).

When that debit leaves remaining HP at zero, the arbiter MUST include a `VerifyZeroCiphertext` proof for the **post-burn** HP vault `available_balance`: the ciphertext Token-2022 will write on the vault (homomorphic leftover), not a freshly encrypted zero. When remaining HP will not be zero, the arbiter MUST NOT include that proof. On-chain handling of presence versus absence, CPI verify, and byte-bind to the vault are [program.md](program.md) **D3**.

The arbiter MUST NOT expose per-strike refusal to the game master. The arbiter MUST NOT reveal the HP draw, `offset`, or the offset range while the instance is live.

### A6. Game master isolation

The game master MUST NOT read the arbiter webapp’s backend: no vault keys, no supply ElGamal or AES keys, no HP mint authority, no HP draw, no per-strike refuse. Using the frontend to sign Initialize or Close does not count as reading the arbiter ([deployment.md](deployment.md) **DEP3**). This is policy. Enforcement is **O1**. If isolation fails, the house knows exact HP and can select a winner.

### A7. Liveness versus censorship

Session liveness is arbiter uptime. A full stall (process down) is distinct from selective censorship (prove only a friend’s Attack). Isolation (**A6**) is intended to allow only the former.

The arbiter exclusive-generates Attack transactions and holds the vault ElGamal keys. Omitting the killing `VerifyZeroCiphertext` on a last hit is the same class of censorship as refusing to prove a strike. Under **D3**, that Attack stays live: leftover HP can be encrypt(0), a further Attack cannot burn 1 from 0, and settlement does not run (pile and reward stay in the vaults; settlement is Attack-only).

v1 MUST NOT add a live-path leftover-nonzero proof to close that endgame lock. The ZK ElGamal Proof Program does not document a nonzero or zero-exclusive-range instruction. `VerifyBatchedRangeProofU64` / `U128` / `U256` certify that a Pedersen commitment holds an unsigned value in `[0, 2ⁿ)`, which **includes 0**. Shifting a commitment by 1 so the documented range excludes 0 would be a homemade proof and is out of scope. A leftover-≥1 check on every live Attack would have blocked burning the last HP without settlement; v1 does not do that. Protecting this omit path is pointless given exclusive transaction generation and key custody.

A failed `VerifyZeroCiphertext` CPI MUST NOT be treated as a live signal; it aborts the Attack (**D3**).

### A8. Deferred (not v1)

A VRF for the HP offset is out of scope for v1.

## Still open

### O1. Isolation enforcement

How **A6** is enforced is unspecified. Software policy on a game-master-hosted host is insufficient if they have root. TEE, third-party operator, or equivalent is not chosen.
