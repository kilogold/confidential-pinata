# Arbiter

Off-chain relay that prices the reward, draws HP, holds vault ElGamal keys, and attaches confidential HP proofs. Deployment is in [deployment.md](deployment.md). On-chain rules live in [program.md](program.md).

v1 does **not** add a second server. The existing **relay is the arbiter** ([deployment.md](deployment.md) **DEP2**).

## Decided

Normative language follows RFC 2119. These decisions apply to the v1 arbiter. They do not specify RPC shapes, key-storage formats, or host configuration.

### A1. Topology

The v1 arbiter MUST be the existing relay process described in [deployment.md](deployment.md), not a second server. Attack is not a player-only transaction: the arbiter MUST participate in every Attack that mutates confidential HP.

### A2. Keys and HP plaintext

Vault ElGamal keys, the HP draw, and proof generation MUST live only on the arbiter. A PDA MUST NOT hold the vault ElGamal secret. After Initialize, live vault keys MUST NOT remain on the game master’s workstation.

### A3. Initialize: price, offset, mint

At Initialize the arbiter MUST:

1. Price the locked public reward in SOL (**A4**).
2. Set \(\mathrm{HP} = \lfloor \mathrm{reward\_in\_SOL} / \mathrm{strike\_fee\_SOL} \rfloor + \mathrm{offset}\).
3. Confidential-mint that HP into the instance HP vault so that public deposit amounts and public mint supply do not reveal HP.

`offset` MUST be an integer \(\geq 0\) (zero is allowed). The closed interval from which `offset` is drawn MUST be known only to the arbiter. Resulting HP MUST be at least 1; Initialize MUST fail otherwise. The game master MUST NOT choose HP.

### A4. Jupiter price

The arbiter MUST price the reward using Jupiter Tokens API v2 as documented at [verified.jup.ag/apis](https://verified.jup.ag/apis): `GET https://api.jup.ag/tokens/v2/search?query=<mint>`. It MUST read `usdPrice` for the reward mint and for wrapped SOL (`So11111111111111111111111111111111111111112`), and MUST compute

\[
\mathrm{reward\_in\_SOL} = (\mathrm{reward\_ui\_amount} \times \mathrm{reward\_usdPrice}) / \mathrm{sol\_usdPrice}
\]

If the mint is absent from the response or `usdPrice` is null, the arbiter MUST treat **1 token = 1 USD** and MUST still convert USD to SOL using Jupiter’s SOL `usdPrice`.

Participants MAY estimate a floor from public Jupiter quotes. They MUST NOT be assumed to know the arbiter’s quote. Price, offset range, and the draw are trusted to the arbiter in v1.

### A5. Attack proofs

The arbiter MUST attach confidential HP proofs for every valid Attack, including the killing HP-zero proof. The public reward transfer on a kill MUST NOT require confidential reward proofs (see [program.md](program.md) D4).

The arbiter MUST NOT expose per-strike refusal to the game master. The arbiter MUST NOT reveal the HP draw, `offset`, or the offset range while the instance is live.

### A6. Game master isolation

The game master MUST NOT read the arbiter: no vault keys, no HP draw, no per-strike refuse. This is policy. Enforcement is **O1**. If isolation fails, the house knows exact HP and can select a winner.

### A7. Liveness versus censorship

Session liveness is arbiter uptime. A full stall (process down) is distinct from selective censorship (prove only a friend’s Attack). Isolation (**A6**) is intended to allow only the former.

### A8. Deferred (not v1)

A VRF for the HP offset is out of scope for v1.

## Still open

### O1. Isolation enforcement

How **A6** is enforced is unspecified. Software policy on a game-master-hosted host is insufficient if they have root. TEE, third-party operator, or equivalent is not chosen.
