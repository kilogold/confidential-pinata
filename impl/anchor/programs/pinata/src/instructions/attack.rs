use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use bytemuck::pod_read_unaligned;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_zk_elgamal_proof_interface::{
    instruction::ProofInstruction, proof_data::zero_ciphertext::ZeroCiphertextProofData,
};
use spl_token_2022_interface::extension::{
    confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions,
    StateWithExtensions,
};
use spl_token_2022_interface::state::Account as TokenAccount;

use crate::errors::PinataError;
use crate::seeds::{SEED_HP_VAULT, SEED_SESSION, SEED_SOL_PILE};
use crate::state::{Session, SessionStatus};
use crate::token_cpi;

#[allow(clippy::too_many_arguments)]
pub fn attack_handler(
    ctx: Context<Attack>,
    _session_id: String,
    equality_proof_instruction_offset: i8,
    ciphertext_validity_proof_instruction_offset: i8,
    range_proof_instruction_offset: i8,
    zero_proof_instruction_offset: i8,
    new_decryptable_available_balance: [u8; 36],
    burn_amount_auditor_ciphertext_lo: [u8; 64],
    burn_amount_auditor_ciphertext_hi: [u8; 64],
) -> Result<()> {
    require!(
        ctx.accounts.session.status == SessionStatus::Live,
        PinataError::SessionNotLive
    );
    require!(
        equality_proof_instruction_offset < 0
            && ciphertext_validity_proof_instruction_offset < 0
            && range_proof_instruction_offset < 0,
        PinataError::InvalidProofInstructionOffset
    );
    require!(
        zero_proof_instruction_offset <= 0,
        PinataError::InvalidZeroProofInstructionOffset
    );

    token_cpi::assert_hp_mint(&ctx.accounts.hp_mint, ctx.accounts.arbiter.key)?;

    // Policy only: the arbiter adds a top-level Memo("strike") so its history
    // scanner can identify attack transactions quickly. TODO: enforce it here
    // through the instructions sysvar if it becomes a protocol requirement.
    invoke(
        &system_instruction::transfer(
            ctx.accounts.attacker.key,
            ctx.accounts.sol_pile.key,
            ctx.accounts.session.strike_fee_lamports,
        ),
        &[
            ctx.accounts.attacker.to_account_info(),
            ctx.accounts.sol_pile.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    token_cpi::confidential_burn(
        &ctx.accounts.hp_vault,
        &ctx.accounts.hp_mint,
        &ctx.accounts.arbiter.to_account_info(),
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        &new_decryptable_available_balance,
        &burn_amount_auditor_ciphertext_lo,
        &burn_amount_auditor_ciphertext_hi,
        equality_proof_instruction_offset,
        ciphertext_validity_proof_instruction_offset,
        range_proof_instruction_offset,
    )?;

    let session = &mut ctx.accounts.session;
    session.successful_attack_count = session
        .successful_attack_count
        .checked_add(1)
        .ok_or(error!(PinataError::AttackCountOverflow))?;

    if zero_proof_instruction_offset < 0 {
        assert_terminal_zero_proof(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &ctx.accounts.hp_vault,
            zero_proof_instruction_offset,
        )?;
        session.status = SessionStatus::Drawing;
    }

    Ok(())
}

fn assert_terminal_zero_proof(
    instructions_sysvar: &AccountInfo,
    hp_vault: &AccountInfo,
    zero_proof_instruction_offset: i8,
) -> Result<()> {
    const PROOF_INSTRUCTION_DISCRIMINATOR_LEN: usize = 1;

    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(PinataError::InvalidTerminalZeroProof))?;
    let proof_index = current_index
        .checked_sub(zero_proof_instruction_offset.unsigned_abs() as u16)
        .ok_or(error!(PinataError::InvalidTerminalZeroProof))?;
    let proof_instruction = load_instruction_at_checked(proof_index as usize, instructions_sysvar)
        .map_err(|_| error!(PinataError::InvalidTerminalZeroProof))?;
    require_keys_eq!(
        proof_instruction.program_id,
        solana_zk_elgamal_proof_interface::ID,
        PinataError::InvalidTerminalZeroProof
    );
    let expected_proof_data_len =
        PROOF_INSTRUCTION_DISCRIMINATOR_LEN + core::mem::size_of::<ZeroCiphertextProofData>();
    require!(
        proof_instruction.data.len() == expected_proof_data_len
            && proof_instruction.data[0] == ProofInstruction::VerifyZeroCiphertext as u8,
        PinataError::InvalidTerminalZeroProof
    );
    let proof_data: ZeroCiphertextProofData =
        pod_read_unaligned(&proof_instruction.data[PROOF_INSTRUCTION_DISCRIMINATOR_LEN..]);

    let hp_vault_data = hp_vault.try_borrow_data()?;
    let hp_vault_state = StateWithExtensions::<TokenAccount>::unpack(&hp_vault_data)
        .map_err(|_| error!(PinataError::InvalidTerminalZeroProof))?;
    let confidential_transfer = hp_vault_state
        .get_extension::<ConfidentialTransferAccount>()
        .map_err(|_| error!(PinataError::InvalidTerminalZeroProof))?;
    require!(
        proof_data.context.pubkey == confidential_transfer.elgamal_pubkey
            && proof_data.context.ciphertext == confidential_transfer.available_balance,
        PinataError::InvalidTerminalZeroProof
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(session_id: String)]
pub struct Attack<'info> {
    #[account(mut)]
    pub attacker: Signer<'info>,
    pub arbiter: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_SESSION, session_id.as_bytes()],
        bump = session.bump,
        constraint = session.arbiter == arbiter.key()
    )]
    pub session: Account<'info, Session>,

    /// CHECK: Token-2022 account at the instance PDA; Token-2022 validates it during the burn.
    #[account(
        mut,
        seeds = [SEED_HP_VAULT, session_id.as_bytes()],
        bump = session.hp_vault_bump,
        owner = spl_token_2022_interface::id()
    )]
    pub hp_vault: UncheckedAccount<'info>,

    /// CHECK: Shared Token-2022 HP mint; validated in the handler.
    #[account(mut, owner = spl_token_2022_interface::id())]
    pub hp_mint: UncheckedAccount<'info>,

    /// CHECK: System PDA that receives the fixed strike fee.
    #[account(
        mut,
        seeds = [SEED_SOL_PILE, session_id.as_bytes()],
        bump = session.sol_pile_bump,
        owner = anchor_lang::system_program::ID
    )]
    pub sol_pile: UncheckedAccount<'info>,

    /// CHECK: Required by Token-2022 and terminal proof validation.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    /// CHECK: Token-2022 program.
    #[account(address = spl_token_2022_interface::id())]
    pub token_2022_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
