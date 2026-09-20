use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod seeds;
pub mod state;
mod token_cpi;

pub use errors::*;
pub use instructions::*;
pub use seeds::*;
pub use state::*;

declare_id!("Dj2EhDwEXx5MpbxwPvVTCoZq6DrYbLURpgkBjTpNjAur");

#[program]
pub mod pinata {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        session_id: String,
        strike_fee_lamports: u64,
        reward_amount: u64,
        pubkey_validity_proof_instruction_offset: i8,
        equality_proof_instruction_offset: i8,
        ciphertext_validity_proof_instruction_offset: i8,
        range_proof_instruction_offset: i8,
        decryptable_zero: [u8; 36],
        new_decryptable_supply: [u8; 36],
        mint_amount_auditor_ciphertext_lo: [u8; 64],
        mint_amount_auditor_ciphertext_hi: [u8; 64],
        expected_pending_balance_credit_counter: u64,
        new_decryptable_available_balance: [u8; 36],
    ) -> Result<()> {
        instructions::initialize::initialize_handler(
            ctx,
            session_id,
            strike_fee_lamports,
            reward_amount,
            pubkey_validity_proof_instruction_offset,
            equality_proof_instruction_offset,
            ciphertext_validity_proof_instruction_offset,
            range_proof_instruction_offset,
            decryptable_zero,
            new_decryptable_supply,
            mint_amount_auditor_ciphertext_lo,
            mint_amount_auditor_ciphertext_hi,
            expected_pending_balance_credit_counter,
            new_decryptable_available_balance,
        )
    }

    pub fn reinitialize(ctx: Context<Reinitialize>, session_id: String) -> Result<()> {
        instructions::reinitialize::reinitialize_handler(ctx, session_id)
    }
}
