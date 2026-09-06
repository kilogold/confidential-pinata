use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod seeds;
pub mod state;
mod token_cpi;

// tests.rs still targets LiteSVM 0.10 + solana-sdk. Keep the file; do not compile
// it until the test rewrite. IDL build compiles the lib-test target.
#[cfg(all(test, feature = "legacy-litesvm-tests"))]
mod tests;

pub use errors::*;
pub use instructions::*;
pub use seeds::*;
pub use state::*;

declare_id!("BMuoaTUJx2ufxqGVBRRmhtgx2adsVBwjKwMqMgAhpw78");

#[program]
pub mod pinata {
    use super::*;

    pub fn initialize(
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
        instructions::initialize::handler(
            ctx,
            session_id,
            strike_fee_lamports,
            reward_amount,
            decryptable_zero,
            new_decryptable_supply,
            mint_amount_auditor_ciphertext_lo,
            mint_amount_auditor_ciphertext_hi,
            expected_pending_balance_credit_counter,
            new_decryptable_available_balance,
        )
    }
}

#[cfg(test)]
mod litesvm_link {
    #[test]
    fn constructs() {
        let _ = litesvm::LiteSVM::new();
    }
}
