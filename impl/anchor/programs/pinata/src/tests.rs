use super::*;
use crate::seeds::{SEED_HP_VAULT, SEED_REWARD_VAULT, SEED_SESSION, SEED_SOL_PILE};
use crate::state::{Session, SessionStatus};
use anchor_lang::AccountSerialize;
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
const TOKEN_PROGRAM_ID: Pubkey = solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

fn initialize_discriminator() -> [u8; 8] {
    let hash = solana_sdk::hash::hash(b"global:initialize");
    hash.to_bytes()[..8].try_into().unwrap()
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

fn dummy_account() -> Account {
    Account {
        lamports: 1_000_000,
        data: vec![0],
        owner: anchor_lang::system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    Account {
        lamports: 10_000_000,
        data: pack_token_account(mint, owner, amount),
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn mint_account(mint_authority: &Pubkey) -> Account {
    Account {
        lamports: 1_000_000,
        data: pack_mint(mint_authority),
        owner: TOKEN_PROGRAM_ID,
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
    svm.add_program_with_loader(ID, program_bytes, solana_sdk::bpf_loader::ID)
        .unwrap_or_else(|e| panic!("add_program failed: {e:?}"));
    svm.set_account(TOKEN_PROGRAM_ID, dummy_account()).unwrap();
    svm.set_account(TOKEN_2022_PROGRAM_ID, dummy_account())
        .unwrap();

    let gm = Keypair::new();
    let arbiter = Keypair::new();
    svm.airdrop(&gm.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&arbiter.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let reward_mint = Pubkey::new_unique();
    let hp_mint = Pubkey::new_unique();
    svm.set_account(reward_mint, mint_account(&gm.pubkey()))
        .unwrap();
    svm.set_account(
        hp_mint,
        Account {
            lamports: 1_000_000,
            data: vec![0; 82],
            owner: TOKEN_2022_PROGRAM_ID,
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
            key,
            Account {
                lamports: 1_000_000,
                data: vec![0; 129],
                owner: ID,
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
    let (session, hp_vault, reward_vault, sol_pile) = session_pdas(session_id);
    let mut data = initialize_discriminator().to_vec();
    let id_bytes = session_id.as_bytes();
    data.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(id_bytes);
    data.extend_from_slice(&strike_fee.to_le_bytes());
    data.extend_from_slice(&reward_amount.to_le_bytes());
    data.extend_from_slice(&[0u8; 36]);
    data.extend_from_slice(&[0u8; 36]);
    data.extend_from_slice(&[0u8; 64]);
    data.extend_from_slice(&[0u8; 64]);
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&[0u8; 36]);

    let mut accounts = vec![
        AccountMeta::new(fx.gm.pubkey(), true),
        AccountMeta::new_readonly(fx.arbiter.pubkey(), include_arbiter),
        AccountMeta::new(session, false),
        AccountMeta::new(hp_vault, false),
        AccountMeta::new(fx.hp_mint, false),
        AccountMeta::new_readonly(fx.reward_mint, false),
        AccountMeta::new(reward_vault, false),
        AccountMeta::new(reward_source, false),
        AccountMeta::new(sol_pile, false),
        AccountMeta::new_readonly(fx.equality, false),
        AccountMeta::new_readonly(fx.ciphertext, false),
        AccountMeta::new_readonly(fx.range, false),
        AccountMeta::new_readonly(pubkey_validity.unwrap_or(ID), false),
        AccountMeta::new_readonly(zero_proof.unwrap_or(ID), false),
        AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
    ];
    if !include_arbiter {
        accounts[1] = AccountMeta::new_readonly(fx.arbiter.pubkey(), false);
    }

    Instruction {
        program_id: ID,
        accounts,
        data,
    }
}

fn fund_reward_accounts(fx: &mut Fixture, session_id: &str, vault_amount: u64) -> Pubkey {
    let gm = fx.gm.pubkey();
    let source = Pubkey::new_unique();
    fx.svm
        .set_account(source, token_account(&fx.reward_mint, &gm, 1_000_000))
        .unwrap();
    let (session, _, reward_vault, _) = session_pdas(session_id);
    fx.svm
        .set_account(
            reward_vault,
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
        owner: ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn send(fx: &mut Fixture, ix: Instruction) -> std::result::Result<(), String> {
    let blockhash = fx.svm.latest_blockhash();
    let signers: Vec<&Keypair> = if ix.accounts[1].is_signer {
        vec![&fx.gm, &fx.arbiter]
    } else {
        vec![&fx.gm]
    };
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&fx.gm.pubkey()), &signers, blockhash);
    fx.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn error_contains(err: &str, needle: &str) -> bool {
    err.to_lowercase().contains(&needle.to_lowercase())
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
        gm: fx.gm.pubkey(),
        arbiter: fx.arbiter.pubkey(),
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
        .set_account(session_pda, session_account(&session))
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
        gm: fx.gm.pubkey(),
        arbiter: fx.arbiter.pubkey(),
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
        .set_account(session_pda, session_account(&session))
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
        gm: fx.gm.pubkey(),
        arbiter: fx.arbiter.pubkey(),
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
        .set_account(session_pda, session_account(&session))
        .unwrap();
    fx.svm
        .set_account(
            sol_pile,
            Account {
                lamports: 2 * LAMPORTS_PER_SOL,
                data: vec![],
                owner: anchor_lang::system_program::ID,
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
        gm: fx.gm.pubkey(),
        arbiter: fx.arbiter.pubkey(),
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
        .set_account(session_pda, session_account(&session))
        .unwrap();
    fx.svm
        .set_account(
            hp_vault,
            Account {
                lamports: 1_000_000,
                data: vec![0; 165],
                owner: TOKEN_2022_PROGRAM_ID,
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
