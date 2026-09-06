use super::*;
use crate::seeds::{SEED_HP_VAULT, SEED_REWARD_VAULT, SEED_SESSION, SEED_SOL_PILE};
use crate::state::{Session, SessionStatus};
use anchor_lang::prelude::pubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData};
use bytemuck::{bytes_of, pod_read_unaligned, Pod};
use curve25519_dalek::scalar::Scalar;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v0, VersionedMessage};
use solana_signer::Signer;
use solana_system_interface::instruction::create_account;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_sdk::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalCiphertext, ElGamalKeypair, ElGamalPubkey},
        grouped_elgamal::GroupedElGamal,
        pedersen::{Pedersen, PedersenOpening},
        AE_CIPHERTEXT_LEN,
    },
    zk_elgamal_proof_program::{
        instruction::{ContextStateInfo, ProofInstruction},
        proof_data::{
            BatchedGroupedCiphertext3HandlesValidityProofData, BatchedRangeProofU128Data,
            CiphertextCommitmentEqualityProofData, PubkeyValidityProofData, ZkProofData,
        },
        state::ProofContextState,
    },
};
use spl_token_2022_interface::{
    extension::{
        confidential_mint_burn::{
            instruction::initialize_mint as initialize_confidential_mint_burn, ConfidentialMintBurn,
        },
        confidential_transfer::{
            instruction::initialize_mint as initialize_confidential_transfer_mint,
            ConfidentialTransferAccount, DecryptableBalance,
        },
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction::initialize_mint2,
    state::{Account as TokenAccountState, Mint as TokenMint},
};
use std::mem::size_of;

const CLUSTER_CU_LIMIT: u32 = 1_400_000;
const HP_AMOUNT: u64 = 5;
const KEY_SEED: &[u8] = b"pinata-hp";
const TOKEN_2022_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/token_2022.so"
);

const TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID: Pubkey =
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

fn to_addr(pk: Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

fn to_pk(addr: Address) -> Pubkey {
    Pubkey::new_from_array(addr.to_bytes())
}

fn ae_bytes(ct: AeCiphertext) -> [u8; AE_CIPHERTEXT_LEN] {
    ct.to_bytes()
}

fn pod64(bytes: &[u8]) -> [u8; 64] {
    bytes.try_into().expect("64-byte ciphertext")
}

fn session_pdas(session_id: &str) -> (Pubkey, Pubkey, Pubkey, Pubkey) {
    let id = session_id.as_bytes();
    let (session, _) = Pubkey::find_program_address(&[SEED_SESSION, id], &ID);
    let (hp_vault, _) = Pubkey::find_program_address(&[SEED_HP_VAULT, id], &ID);
    let (reward_vault, _) = Pubkey::find_program_address(&[SEED_REWARD_VAULT, id], &ID);
    let (sol_pile, _) = Pubkey::find_program_address(&[SEED_SOL_PILE, id], &ID);
    (session, hp_vault, reward_vault, sol_pile)
}

fn pack_mint(mint_authority: &Pubkey) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[0] = 1;
    data[4..36].copy_from_slice(mint_authority.as_ref());
    data[44] = 6;
    data[45] = 1;
    data
}

fn pack_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    data
}

fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    Account {
        lamports: 10_000_000,
        data: pack_token_account(mint, owner, amount),
        owner: to_addr(TOKEN_PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn mint_account(mint_authority: &Pubkey) -> Account {
    Account {
        lamports: 1_000_000,
        data: pack_mint(mint_authority),
        owner: to_addr(TOKEN_PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }
}

struct Fixture {
    svm: LiteSVM,
    gm: Keypair,
    arbiter: Keypair,
    reward_mint: Pubkey,
    hp_mint: Pubkey,
    equality: Pubkey,
    ciphertext: Pubkey,
    range: Pubkey,
    pubkey_validity: Pubkey,
    zero_proof: Pubkey,
}

fn setup() -> Fixture {
    let mut svm = LiteSVM::new();
    let program_bytes = include_bytes!("../../../target/deploy/pinata.so");
    svm.add_program(to_addr(ID), program_bytes)
        .unwrap_or_else(|e| panic!("add_program failed: {e:?}"));
    svm.add_program_from_file(to_addr(TOKEN_2022_PROGRAM_ID), TOKEN_2022_SO)
        .unwrap_or_else(|e| panic!("load Token-2022: {e:?}"));

    let gm = Keypair::new();
    let arbiter = Keypair::new();
    svm.airdrop(&gm.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&arbiter.pubkey(), 1_000_000_000).unwrap();

    let reward_mint = Pubkey::new_unique();
    let hp_mint = Pubkey::new_unique();
    svm.set_account(to_addr(reward_mint), mint_account(&to_pk(gm.pubkey())))
        .unwrap();
    svm.set_account(
        to_addr(hp_mint),
        Account {
            lamports: 1_000_000,
            data: vec![0; 82],
            owner: to_addr(TOKEN_2022_PROGRAM_ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let equality = Pubkey::new_unique();
    let ciphertext = Pubkey::new_unique();
    let range = Pubkey::new_unique();
    let pubkey_validity = Pubkey::new_unique();
    let zero_proof = Pubkey::new_unique();
    for key in [equality, ciphertext, range, pubkey_validity, zero_proof] {
        svm.set_account(
            to_addr(key),
            Account {
                lamports: 1_000_000,
                data: vec![0; 129],
                owner: to_addr(ID),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }

    Fixture {
        svm,
        gm,
        arbiter,
        reward_mint,
        hp_mint,
        equality,
        ciphertext,
        range,
        pubkey_validity,
        zero_proof,
    }
}

struct ConfidentialArgs {
    decryptable_zero: [u8; 36],
    new_decryptable_supply: [u8; 36],
    mint_amount_auditor_ciphertext_lo: [u8; 64],
    mint_amount_auditor_ciphertext_hi: [u8; 64],
    expected_pending_balance_credit_counter: u64,
    new_decryptable_available_balance: [u8; 36],
}

impl Default for ConfidentialArgs {
    fn default() -> Self {
        Self {
            decryptable_zero: [0u8; 36],
            new_decryptable_supply: [0u8; 36],
            mint_amount_auditor_ciphertext_lo: [0u8; 64],
            mint_amount_auditor_ciphertext_hi: [0u8; 64],
            expected_pending_balance_credit_counter: 1,
            new_decryptable_available_balance: [0u8; 36],
        }
    }
}

fn initialize_ix(
    fx: &Fixture,
    session_id: &str,
    strike_fee: u64,
    reward_amount: u64,
    include_arbiter: bool,
    pubkey_validity: Option<Pubkey>,
    zero_proof: Option<Pubkey>,
    reward_source: Pubkey,
) -> Instruction {
    initialize_ix_with(
        fx,
        session_id,
        strike_fee,
        reward_amount,
        include_arbiter,
        pubkey_validity,
        zero_proof,
        reward_source,
        ConfidentialArgs::default(),
    )
}

fn initialize_ix_with(
    fx: &Fixture,
    session_id: &str,
    strike_fee: u64,
    reward_amount: u64,
    include_arbiter: bool,
    pubkey_validity: Option<Pubkey>,
    zero_proof: Option<Pubkey>,
    reward_source: Pubkey,
    conf: ConfidentialArgs,
) -> Instruction {
    let (session, hp_vault, reward_vault, sol_pile) = session_pdas(session_id);
    let data = crate::instruction::Initialize {
        session_id: session_id.to_string(),
        strike_fee_lamports: strike_fee,
        reward_amount,
        decryptable_zero: conf.decryptable_zero,
        new_decryptable_supply: conf.new_decryptable_supply,
        mint_amount_auditor_ciphertext_lo: conf.mint_amount_auditor_ciphertext_lo,
        mint_amount_auditor_ciphertext_hi: conf.mint_amount_auditor_ciphertext_hi,
        expected_pending_balance_credit_counter: conf.expected_pending_balance_credit_counter,
        new_decryptable_available_balance: conf.new_decryptable_available_balance,
    }
    .data();

    let accounts = vec![
        AccountMeta::new(fx.gm.pubkey(), true),
        AccountMeta::new_readonly(fx.arbiter.pubkey(), include_arbiter),
        AccountMeta::new(to_addr(session), false),
        AccountMeta::new(to_addr(hp_vault), false),
        AccountMeta::new(to_addr(fx.hp_mint), false),
        AccountMeta::new_readonly(to_addr(fx.reward_mint), false),
        AccountMeta::new(to_addr(reward_vault), false),
        AccountMeta::new(to_addr(reward_source), false),
        AccountMeta::new(to_addr(sol_pile), false),
        AccountMeta::new_readonly(to_addr(fx.equality), false),
        AccountMeta::new_readonly(to_addr(fx.ciphertext), false),
        AccountMeta::new_readonly(to_addr(fx.range), false),
        AccountMeta::new_readonly(to_addr(pubkey_validity.unwrap_or(ID)), false),
        AccountMeta::new_readonly(to_addr(zero_proof.unwrap_or(ID)), false),
        AccountMeta::new_readonly(to_addr(TOKEN_2022_PROGRAM_ID), false),
        AccountMeta::new_readonly(to_addr(TOKEN_PROGRAM_ID), false),
        AccountMeta::new_readonly(to_addr(anchor_lang::system_program::ID), false),
    ];

    Instruction {
        program_id: to_addr(ID),
        accounts,
        data,
    }
}

fn fund_reward_accounts(fx: &mut Fixture, session_id: &str, vault_amount: u64) -> Pubkey {
    let gm = to_pk(fx.gm.pubkey());
    let source = Pubkey::new_unique();
    fx.svm
        .set_account(to_addr(source), token_account(&fx.reward_mint, &gm, 1_000_000))
        .unwrap();
    let (session, _, reward_vault, _) = session_pdas(session_id);
    fx.svm
        .set_account(
            to_addr(reward_vault),
            token_account(&fx.reward_mint, &session, vault_amount),
        )
        .unwrap();
    source
}

fn pack_session(session: &Session) -> Vec<u8> {
    let mut data = Vec::new();
    session.try_serialize(&mut data).unwrap();
    data
}

fn session_account(session: &Session) -> Account {
    Account {
        lamports: 10_000_000,
        data: pack_session(session),
        owner: to_addr(ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn cu_limit() -> Instruction {
    ComputeBudgetInstruction::set_compute_unit_limit(CLUSTER_CU_LIMIT)
}

fn send_ixs(
    fx: &mut Fixture,
    ixs: &[Instruction],
    extra: &[&Keypair],
) -> std::result::Result<u64, String> {
    let mut signers: Vec<&Keypair> = vec![&fx.gm];
    if ixs
        .iter()
        .any(|ix| ix.accounts.iter().any(|m| m.pubkey == fx.arbiter.pubkey() && m.is_signer))
    {
        signers.push(&fx.arbiter);
    }
    signers.extend_from_slice(extra);
    let mut ixs = ixs.to_vec();
    if !ixs
        .first()
        .map(|ix| ix.program_id == solana_compute_budget_interface::ID)
        .unwrap_or(false)
    {
        ixs.insert(0, cu_limit());
    }
    let blockhash = fx.svm.latest_blockhash();
    let msg = v0::Message::try_compile(&fx.gm.pubkey(), &ixs, &[], blockhash)
        .map_err(|e| format!("v0 compile: {e:?}"))?;
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &signers)
        .map_err(|e| format!("v0 sign: {e:?}"))?;
    let meta = fx.svm.send_transaction(tx).map_err(|e| format!("{e:?}"))?;
    assert!(
        meta.compute_units_consumed <= CLUSTER_CU_LIMIT as u64,
        "tx used {} CU (cluster cap {CLUSTER_CU_LIMIT})",
        meta.compute_units_consumed
    );
    Ok(meta.compute_units_consumed)
}

fn send(fx: &mut Fixture, ix: Instruction) -> std::result::Result<(), String> {
    send_ixs(fx, &[ix], &[]).map(|_| ())
}

fn error_contains(err: &str, needle: &str) -> bool {
    err.to_lowercase().contains(&needle.to_lowercase())
}

fn hp_keys(arbiter: &Keypair) -> (ElGamalKeypair, AeKey) {
    let elgamal = ElGamalKeypair::new_from_signer(arbiter, KEY_SEED).unwrap();
    let aes = AeKey::new_from_signer(arbiter, KEY_SEED).unwrap();
    (elgamal, aes)
}

fn try_split_u64(amount: u64, bit_length: usize) -> Option<(u64, u64)> {
    match bit_length {
        0 => Some((0, amount)),
        1..=63 => {
            let complement = u64::BITS.checked_sub(bit_length as u32)?;
            let lo = amount.checked_shl(complement)?.checked_shr(complement)?;
            let hi = amount.checked_shr(bit_length as u32)?;
            Some((lo, hi))
        }
        64 => Some((amount, 0)),
        _ => None,
    }
}

fn mint_proofs(
    current_supply_ciphertext: &ElGamalCiphertext,
    mint_amount: u64,
    current_supply: u64,
    supply_elgamal: &ElGamalKeypair,
    destination: &ElGamalPubkey,
) -> (
    CiphertextCommitmentEqualityProofData,
    BatchedGroupedCiphertext3HandlesValidityProofData,
    BatchedRangeProofU128Data,
    [u8; 64],
    [u8; 64],
) {
    let auditor = ElGamalPubkey::default();
    let (lo, hi) = try_split_u64(mint_amount, 16).unwrap();
    let opening_lo = PedersenOpening::new_rand();
    let opening_hi = PedersenOpening::new_rand();
    let grouped_lo = GroupedElGamal::encrypt_with(
        [destination, supply_elgamal.pubkey(), &auditor],
        lo,
        &opening_lo,
    );
    let grouped_hi = GroupedElGamal::encrypt_with(
        [destination, supply_elgamal.pubkey(), &auditor],
        hi,
        &opening_hi,
    );
    let supply_lo = grouped_lo.to_elgamal_ciphertext(1).unwrap();
    let supply_hi = grouped_hi.to_elgamal_ciphertext(1).unwrap();
    let two_power = Scalar::from(1_u64 << 16);
    let hi_shifted = &supply_hi * &two_power;
    let new_supply_ciphertext = &(current_supply_ciphertext + &supply_lo) + &hi_shifted;
    let new_supply = current_supply.checked_add(mint_amount).unwrap();
    let (new_supply_commitment, new_supply_opening) = Pedersen::new(new_supply);

    let equality = CiphertextCommitmentEqualityProofData::new(
        supply_elgamal,
        &new_supply_ciphertext,
        &new_supply_commitment,
        &new_supply_opening,
        new_supply,
    )
    .unwrap();
    let validity = BatchedGroupedCiphertext3HandlesValidityProofData::new(
        destination,
        supply_elgamal.pubkey(),
        &auditor,
        &grouped_lo,
        &grouped_hi,
        lo,
        hi,
        &opening_lo,
        &opening_hi,
    )
    .unwrap();
    let auditor_lo = pod64(bytes_of(
        &validity
            .context_data()
            .grouped_ciphertext_lo
            .try_extract_ciphertext(2)
            .unwrap(),
    ));
    let auditor_hi = pod64(bytes_of(
        &validity
            .context_data()
            .grouped_ciphertext_hi
            .try_extract_ciphertext(2)
            .unwrap(),
    ));
    let (padding_commitment, padding_opening) = Pedersen::new(0_u64);
    let range = BatchedRangeProofU128Data::new(
        vec![
            &new_supply_commitment,
            &grouped_lo.commitment,
            &grouped_hi.commitment,
            &padding_commitment,
        ],
        vec![new_supply, lo, hi, 0],
        vec![64, 16, 32, 16],
        vec![
            &new_supply_opening,
            &opening_lo,
            &opening_hi,
            &padding_opening,
        ],
    )
    .unwrap();
    (equality, validity, range, auditor_lo, auditor_hi)
}

fn verify_into_context<T, U>(
    fx: &mut Fixture,
    proof_ix: ProofInstruction,
    proof: &T,
) -> Address
where
    T: Pod + ZkProofData<U>,
    U: Pod,
{
    let context = Address::new_unique();
    let space = size_of::<ProofContextState<U>>();
    let lamports = fx.svm.minimum_balance_for_rent_exemption(space);
    fx.svm
        .set_account(
            context,
            Account {
                lamports,
                data: vec![0; space],
                owner: solana_zk_sdk::zk_elgamal_proof_program::id(),
                ..Default::default()
            },
        )
        .unwrap();
    let authority = fx.arbiter.pubkey();
    let info = ContextStateInfo {
        context_state_account: &context,
        context_state_authority: &authority,
    };
    let proof_bytes = bytes_of(proof);
    let verify = if proof_bytes.len() > 800 {
        let proof_acc = Address::new_unique();
        fx.svm
            .set_account(
                proof_acc,
                Account {
                    lamports: fx
                        .svm
                        .minimum_balance_for_rent_exemption(proof_bytes.len()),
                    data: proof_bytes.to_vec(),
                    owner: to_addr(anchor_lang::system_program::ID),
                    ..Default::default()
                },
            )
            .unwrap();
        proof_ix.encode_verify_proof_from_account(Some(info), &proof_acc, 0)
    } else {
        proof_ix.encode_verify_proof(Some(info), proof)
    };
    send_ixs(fx, &[verify], &[]).unwrap();
    context
}

fn create_hp_mint(fx: &mut Fixture, elgamal: &ElGamalKeypair, aes: &AeKey) {
    let mint = Keypair::new();
    let mint_pk = mint.pubkey();
    let space = ExtensionType::try_calculate_account_len::<TokenMint>(&[
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::ConfidentialMintBurn,
    ])
    .unwrap();
    let lamports = fx.svm.minimum_balance_for_rent_exemption(space);
    let t22 = to_addr(TOKEN_2022_PROGRAM_ID);
    let arb = fx.arbiter.pubkey();
    let supply_pk = pod_read_unaligned(&elgamal.pubkey().to_bytes());
    let decryptable: DecryptableBalance = pod_read_unaligned(&ae_bytes(aes.encrypt(0)));
    send_ixs(
        fx,
        &[
            create_account(&fx.gm.pubkey(), &mint_pk, lamports, space as u64, &t22),
            initialize_confidential_transfer_mint(&t22, &mint_pk, Some(arb), true, None).unwrap(),
            initialize_confidential_mint_burn(&t22, &mint_pk, &supply_pk, &decryptable).unwrap(),
            initialize_mint2(&t22, &mint_pk, &arb, None, 0).unwrap(),
        ],
        &[&mint],
    )
    .unwrap();
    fx.hp_mint = to_pk(mint_pk);
}

fn supply_ciphertext(fx: &Fixture) -> ElGamalCiphertext {
    let data = fx.svm.get_account(&to_addr(fx.hp_mint)).unwrap().data;
    let mint = StateWithExtensions::<TokenMint>::unpack(&data).unwrap();
    let ext = mint.get_extension::<ConfidentialMintBurn>().unwrap();
    ElGamalCiphertext::from_bytes(&bytes_of(&ext.confidential_supply)).unwrap()
}

#[test]
fn session_id_empty_fails() {
    let mut fx = setup();
    let source = fund_reward_accounts(&mut fx, "", 0);
    let ix = initialize_ix(&fx, "", 1, 1, true, Some(fx.pubkey_validity), None, source);
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "InvalidSessionId"), "{err}");
}

#[test]
fn session_id_too_long_fails() {
    let mut fx = setup();
    let session_id = "abcdefghijklmnopqrstuvwxy";
    assert_eq!(session_id.len(), 25);
    let source = fund_reward_accounts(&mut fx, session_id, 0);
    let ix = initialize_ix(
        &fx,
        session_id,
        1,
        1,
        true,
        Some(fx.pubkey_validity),
        None,
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "InvalidSessionId"), "{err}");
}

#[test]
fn zero_reward_fails() {
    let mut fx = setup();
    let source = fund_reward_accounts(&mut fx, "zero-reward", 0);
    let ix = initialize_ix(
        &fx,
        "zero-reward",
        1,
        0,
        true,
        Some(fx.pubkey_validity),
        None,
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "InvalidRewardAmount"), "{err}");
}

#[test]
fn zero_strike_fee_fails() {
    let mut fx = setup();
    let source = fund_reward_accounts(&mut fx, "zero-fee", 0);
    let ix = initialize_ix(
        &fx,
        "zero-fee",
        0,
        1,
        true,
        Some(fx.pubkey_validity),
        None,
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "InvalidStrikeFee"), "{err}");
}

#[test]
fn missing_arbiter_signature_fails() {
    let mut fx = setup();
    let source = fund_reward_accounts(&mut fx, "no-arbiter", 0);
    let ix = initialize_ix(
        &fx,
        "no-arbiter",
        1,
        1,
        false,
        Some(fx.pubkey_validity),
        None,
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(
        error_contains(&err, "AccountNotSigner") || error_contains(&err, "did not sign"),
        "{err}"
    );
}

#[test]
fn live_session_already_exists() {
    let mut fx = setup();
    let session_id = "live-one";
    let source = fund_reward_accounts(&mut fx, session_id, 0);
    let (session_pda, _, _, _) = session_pdas(session_id);
    let mut session = Session {
        gm: to_pk(fx.gm.pubkey()),
        arbiter: to_pk(fx.arbiter.pubkey()),
        reward_mint: fx.reward_mint,
        strike_fee_lamports: 1,
        reward_amount: 1,
        status: SessionStatus::Live,
        session_id: [0u8; 24],
        session_id_len: 0,
        bump: 0,
        hp_vault_bump: 0,
        reward_vault_bump: 0,
        sol_pile_bump: 0,
    };
    session.write_session_id(session_id.as_bytes());
    fx.svm
        .set_account(to_addr(session_pda), session_account(&session))
        .unwrap();

    let ix = initialize_ix(
        &fx,
        session_id,
        1,
        1,
        true,
        Some(fx.pubkey_validity),
        None,
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(
        error_contains(&err, "PinataAlreadyExists") || error_contains(&err, "already exists"),
        "{err}"
    );
}

#[test]
fn game_over_nonempty_reward_fails() {
    let mut fx = setup();
    let session_id = "over-reward";
    let source = fund_reward_accounts(&mut fx, session_id, 50);
    let (session_pda, _, _, _) = session_pdas(session_id);
    let mut session = Session {
        gm: to_pk(fx.gm.pubkey()),
        arbiter: to_pk(fx.arbiter.pubkey()),
        reward_mint: fx.reward_mint,
        strike_fee_lamports: 1,
        reward_amount: 1,
        status: SessionStatus::GameOver,
        session_id: [0u8; 24],
        session_id_len: 0,
        bump: 0,
        hp_vault_bump: 0,
        reward_vault_bump: 0,
        sol_pile_bump: 0,
    };
    session.write_session_id(session_id.as_bytes());
    fx.svm
        .set_account(to_addr(session_pda), session_account(&session))
        .unwrap();

    let ix = initialize_ix(
        &fx,
        session_id,
        1,
        1,
        true,
        Some(fx.pubkey_validity),
        Some(fx.zero_proof),
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "RewardVaultNotEmpty"), "{err}");
}

#[test]
fn game_over_nonempty_sol_pile_fails() {
    let mut fx = setup();
    let session_id = "over-sol";
    let source = fund_reward_accounts(&mut fx, session_id, 0);
    let (session_pda, _, _, sol_pile) = session_pdas(session_id);
    let mut session = Session {
        gm: to_pk(fx.gm.pubkey()),
        arbiter: to_pk(fx.arbiter.pubkey()),
        reward_mint: fx.reward_mint,
        strike_fee_lamports: 1,
        reward_amount: 1,
        status: SessionStatus::GameOver,
        session_id: [0u8; 24],
        session_id_len: 0,
        bump: 0,
        hp_vault_bump: 0,
        reward_vault_bump: 0,
        sol_pile_bump: 0,
    };
    session.write_session_id(session_id.as_bytes());
    fx.svm
        .set_account(to_addr(session_pda), session_account(&session))
        .unwrap();
    fx.svm
        .set_account(
            to_addr(sol_pile),
            Account {
                lamports: 2_000_000_000,
                data: vec![],
                owner: to_addr(anchor_lang::system_program::ID),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let ix = initialize_ix(
        &fx,
        session_id,
        1,
        1,
        true,
        Some(fx.pubkey_validity),
        Some(fx.zero_proof),
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "SolPileNotEmpty"), "{err}");
}

#[test]
fn game_over_missing_zero_proof_fails() {
    let mut fx = setup();
    let session_id = "over-zp";
    let source = fund_reward_accounts(&mut fx, session_id, 0);
    let (session_pda, hp_vault, _, _) = session_pdas(session_id);
    let mut session = Session {
        gm: to_pk(fx.gm.pubkey()),
        arbiter: to_pk(fx.arbiter.pubkey()),
        reward_mint: fx.reward_mint,
        strike_fee_lamports: 1,
        reward_amount: 1,
        status: SessionStatus::GameOver,
        session_id: [0u8; 24],
        session_id_len: 0,
        bump: 0,
        hp_vault_bump: 0,
        reward_vault_bump: 0,
        sol_pile_bump: 0,
    };
    session.write_session_id(session_id.as_bytes());
    fx.svm
        .set_account(to_addr(session_pda), session_account(&session))
        .unwrap();
    fx.svm
        .set_account(
            to_addr(hp_vault),
            Account {
                lamports: 1_000_000,
                data: vec![0; 165],
                owner: to_addr(TOKEN_2022_PROGRAM_ID),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let ix = initialize_ix(
        &fx,
        session_id,
        1,
        1,
        true,
        Some(fx.pubkey_validity),
        None,
        source,
    );
    let err = send(&mut fx, ix).unwrap_err();
    assert!(error_contains(&err, "MissingZeroProof"), "{err}");
}

#[test]
fn initialize_confidential_mint_succeeds() {
    let mut fx = setup();
    let session_id = "hp-mint";
    let source = fund_reward_accounts(&mut fx, session_id, 0);
    let (elgamal, aes) = hp_keys(&fx.arbiter);
    create_hp_mint(&mut fx, &elgamal, &aes);

    let pubkey_proof = PubkeyValidityProofData::new(&elgamal).unwrap();
    let (equality, validity, range, mint_lo, mint_hi) = mint_proofs(
        &supply_ciphertext(&fx),
        HP_AMOUNT,
        0,
        &elgamal,
        elgamal.pubkey(),
    );

    fx.pubkey_validity = to_pk(verify_into_context(
        &mut fx,
        ProofInstruction::VerifyPubkeyValidity,
        &pubkey_proof,
    ));
    fx.equality = to_pk(verify_into_context(
        &mut fx,
        ProofInstruction::VerifyCiphertextCommitmentEquality,
        &equality,
    ));
    fx.ciphertext = to_pk(verify_into_context(
        &mut fx,
        ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity,
        &validity,
    ));
    fx.range = to_pk(verify_into_context(
        &mut fx,
        ProofInstruction::VerifyBatchedRangeProofU128,
        &range,
    ));

    let decryptable_zero = ae_bytes(aes.encrypt(0));
    let new_supply = ae_bytes(aes.encrypt(HP_AMOUNT));
    let ix = initialize_ix_with(
        &fx,
        session_id,
        1,
        1,
        true,
        Some(fx.pubkey_validity),
        None,
        source,
        ConfidentialArgs {
            decryptable_zero,
            new_decryptable_supply: new_supply,
            mint_amount_auditor_ciphertext_lo: mint_lo,
            mint_amount_auditor_ciphertext_hi: mint_hi,
            expected_pending_balance_credit_counter: 1,
            new_decryptable_available_balance: new_supply,
        },
    );
    send(&mut fx, ix).unwrap_or_else(|e| panic!("initialize failed: {e}"));

    let (session_pda, hp_vault, reward_vault, _) = session_pdas(session_id);
    let session_acc = fx.svm.get_account(&to_addr(session_pda)).unwrap();
    let session = Session::try_deserialize(&mut session_acc.data.as_slice()).unwrap();
    assert!(
        session.status == SessionStatus::Live,
        "expected Live session"
    );
    assert_eq!(session.reward_amount, 1);

    let reward = fx.svm.get_account(&to_addr(reward_vault)).unwrap();
    let reward_state = StateWithExtensions::<TokenAccountState>::unpack(&reward.data).unwrap();
    assert_eq!(reward_state.base.amount, 1);

    let vault = fx.svm.get_account(&to_addr(hp_vault)).unwrap();
    let vault_state = StateWithExtensions::<TokenAccountState>::unpack(&vault.data).unwrap();
    let ct = vault_state
        .get_extension::<ConfidentialTransferAccount>()
        .unwrap();
    let decryptable = AeCiphertext::from_bytes(bytes_of(&ct.decryptable_available_balance))
        .expect("decryptable available");
    assert_eq!(aes.decrypt(&decryptable), Some(HP_AMOUNT));
}
