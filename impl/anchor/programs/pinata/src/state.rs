use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SessionStatus {
    Uninitialized,
    Live,
    GameOver,
    Drawing,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub gm: Pubkey,
    pub arbiter: Pubkey,
    pub reward_mint: Pubkey,
    pub strike_fee_lamports: u64,
    pub reward_amount: u64,
    pub successful_attack_count: u64,
    pub status: SessionStatus,
    pub bump: u8,
    pub hp_vault_bump: u8,
    pub reward_vault_bump: u8,
    pub sol_pile_bump: u8,
}
