use anchor_lang::prelude::*;

use crate::seeds::SESSION_ID_MAX;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SessionStatus {
    Uninitialized,
    Live,
    GameOver,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub gm: Pubkey,
    pub arbiter: Pubkey,
    pub reward_mint: Pubkey,
    pub strike_fee_lamports: u64,
    pub reward_amount: u64,
    pub status: SessionStatus,
    pub session_id: [u8; SESSION_ID_MAX],
    pub session_id_len: u8,
    pub bump: u8,
    pub hp_vault_bump: u8,
    pub reward_vault_bump: u8,
    pub sol_pile_bump: u8,
}

impl Session {
    pub fn write_session_id(&mut self, session_id: &[u8]) {
        self.session_id = [0u8; SESSION_ID_MAX];
        self.session_id[..session_id.len()].copy_from_slice(session_id);
        self.session_id_len = session_id.len() as u8;
    }
}
