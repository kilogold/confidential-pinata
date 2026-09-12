use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::errors::PinataError;
use crate::seeds::{SEED_HP_VAULT, SEED_REWARD_VAULT, SEED_SESSION, SEED_SOL_PILE, SESSION_ID_MAX};
use crate::state::{Session, SessionStatus};
use crate::token_cpi;

pub fn handler(
    ctx: Context<Initialize>,
    session_id: String,
    strike_fee_lamports: u64,
    reward_amount: u64,
    decryptable_zero: [u8; 36],
    new_decryptable_supply: [u8; 36],
    mint_amount_auditor_ciphertext_lo: [u8; 64],
    mint_amount_auditor_ciphertext_hi: [u8; 64],
    expected_pending_balance_credit_counter: u64,
    new_decryptable_available_balance: [u8; 36],
) -> Result<()> {
    let session_id_bytes = session_id.as_bytes();
    require!(
        !session_id_bytes.is_empty() && session_id_bytes.len() <= SESSION_ID_MAX,
        PinataError::InvalidSessionId
    );
    require!(strike_fee_lamports > 0, PinataError::InvalidStrikeFee);
    require!(reward_amount > 0, PinataError::InvalidRewardAmount);

    match ctx.accounts.session.status {
        SessionStatus::Live => return err!(PinataError::PinataAlreadyExists),
        SessionStatus::GameOver => reinit_gates(&ctx)?,
        SessionStatus::Uninitialized => {}
    }

    token_cpi::assert_hp_mint(&ctx.accounts.hp_mint, ctx.accounts.arbiter.key)?;

    if token_cpi::needs_hp_vault_create(&ctx.accounts.hp_vault) {
        let pubkey_validity = ctx
            .accounts
            .pubkey_validity_proof
            .as_ref()
            .ok_or(PinataError::MissingPubkeyValidityProof)?;
        let bump = ctx.bumps.hp_vault;
        let seeds: &[&[u8]] = &[SEED_HP_VAULT, session_id_bytes, &[bump]];
        token_cpi::create_hp_vault(
            &ctx.accounts.gm.to_account_info(),
            &ctx.accounts.arbiter.to_account_info(),
            &ctx.accounts.hp_vault,
            &ctx.accounts.hp_mint,
            &pubkey_validity.to_account_info(),
            &ctx.accounts.token_2022_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &decryptable_zero,
            seeds,
        )?;
    }

    token_cpi::confidential_mint(
        &ctx.accounts.hp_vault,
        &ctx.accounts.hp_mint,
        &ctx.accounts.arbiter.to_account_info(),
        &ctx.accounts.equality_proof,
        &ctx.accounts.ciphertext_validity_proof,
        &ctx.accounts.range_proof,
        &ctx.accounts.token_2022_program.to_account_info(),
        &new_decryptable_supply,
        &mint_amount_auditor_ciphertext_lo,
        &mint_amount_auditor_ciphertext_hi,
    )?;

    token_cpi::apply_pending_balance_cpi(
        &ctx.accounts.hp_vault,
        &ctx.accounts.arbiter.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        expected_pending_balance_credit_counter,
        &new_decryptable_available_balance,
    )?;

    ensure_sol_pile_rent(&ctx)?;

    token_cpi::transfer_reward(
        &ctx.accounts.reward_token_program.to_account_info(),
        &ctx.accounts.reward_source.to_account_info(),
        &ctx.accounts.reward_mint.to_account_info(),
        &ctx.accounts.reward_vault.to_account_info(),
        &ctx.accounts.gm.to_account_info(),
        reward_amount,
        ctx.accounts.reward_mint.decimals,
    )?;

    let session = &mut ctx.accounts.session;
    session.gm = ctx.accounts.gm.key();
    session.arbiter = ctx.accounts.arbiter.key();
    session.reward_mint = ctx.accounts.reward_mint.key();
    session.strike_fee_lamports = strike_fee_lamports;
    session.reward_amount = reward_amount;
    session.status = SessionStatus::Live;
    session.write_session_id(session_id_bytes);
    session.bump = ctx.bumps.session;
    session.hp_vault_bump = ctx.bumps.hp_vault;
    session.reward_vault_bump = ctx.bumps.reward_vault;
    session.sol_pile_bump = ctx.bumps.sol_pile;

    Ok(())
}

fn reinit_gates(ctx: &Context<Initialize>) -> Result<()> {
    if !token_cpi::needs_hp_vault_create(&ctx.accounts.hp_vault) {
        let zero_proof = ctx
            .accounts
            .zero_proof
            .as_ref()
            .ok_or(PinataError::MissingZeroProof)?;
        token_cpi::bind_zero_proof(&zero_proof.to_account_info(), &ctx.accounts.hp_vault)?;
    }

    require!(
        ctx.accounts.reward_vault.amount == 0,
        PinataError::RewardVaultNotEmpty
    );

    let sol_pile = &ctx.accounts.sol_pile;
    if sol_pile.lamports() > 0 {
        let rent = Rent::get()?.minimum_balance(sol_pile.data_len());
        require!(sol_pile.lamports() == rent, PinataError::SolPileNotEmpty);
    }

    Ok(())
}

fn ensure_sol_pile_rent(ctx: &Context<Initialize>) -> Result<()> {
    let sol_pile = &ctx.accounts.sol_pile;
    let rent = Rent::get()?.minimum_balance(sol_pile.data_len());
    if sol_pile.lamports() < rent {
        invoke(
            &system_instruction::transfer(
                ctx.accounts.gm.key,
                sol_pile.key,
                rent.saturating_sub(sol_pile.lamports()),
            ),
            &[
                ctx.accounts.gm.to_account_info(),
                sol_pile.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(session_id: String)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub gm: Signer<'info>,
    pub arbiter: Signer<'info>,

    #[account(
        init_if_needed,
        payer = gm,
        space = 8 + Session::INIT_SPACE,
        seeds = [SEED_SESSION, session_id.as_bytes()],
        bump
    )]
    pub session: Account<'info, Session>,

    /// CHECK: PDA; created as a Token-2022 confidential account when empty.
    #[account(
        mut,
        seeds = [SEED_HP_VAULT, session_id.as_bytes()],
        bump
    )]
    pub hp_vault: UncheckedAccount<'info>,

    /// CHECK: Shared Token-2022 HP mint; validated in the handler.
    #[account(mut)]
    pub hp_mint: UncheckedAccount<'info>,

    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = gm,
        token::mint = reward_mint,
        token::authority = session,
        token::token_program = reward_token_program,
        seeds = [SEED_REWARD_VAULT, session_id.as_bytes()],
        bump
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = gm,
        token::token_program = reward_token_program
    )]
    pub reward_source: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: System PDA holding strike SOL. Spendable only via pinata invoke_signed.
    #[account(
        mut,
        seeds = [SEED_SOL_PILE, session_id.as_bytes()],
        bump
    )]
    pub sol_pile: UncheckedAccount<'info>,

    /// CHECK: Pre-verified CiphertextCommitmentEquality context.
    pub equality_proof: UncheckedAccount<'info>,
    /// CHECK: Pre-verified BatchedGroupedCiphertext3HandlesValidity context.
    pub ciphertext_validity_proof: UncheckedAccount<'info>,
    /// CHECK: Pre-verified BatchedRangeProofU128 context.
    pub range_proof: UncheckedAccount<'info>,
    /// CHECK: Pre-verified PubkeyValidity context; required when creating hp_vault.
    pub pubkey_validity_proof: Option<UncheckedAccount<'info>>,
    /// CHECK: Pre-verified ZeroCiphertext context; required on Game Over re-init.
    pub zero_proof: Option<UncheckedAccount<'info>>,

    /// CHECK: Token-2022 program.
    #[account(address = spl_token_2022_interface::id())]
    pub token_2022_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022.
    #[account(constraint = is_token_program(reward_token_program.key()))]
    pub reward_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn is_token_program(key: Pubkey) -> bool {
    key == spl_token_2022_interface::id() || key == anchor_spl::token::ID
}
