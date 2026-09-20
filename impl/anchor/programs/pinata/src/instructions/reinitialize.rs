use anchor_lang::prelude::*;

use crate::errors::PinataError;
use crate::seeds::SEED_SESSION;
use crate::state::Session;

pub fn reinitialize_handler(_ctx: Context<Reinitialize>, _session_id: String) -> Result<()> {
    err!(PinataError::ReinitializeNotImplemented)
}

#[derive(Accounts)]
#[instruction(session_id: String)]
pub struct Reinitialize<'info> {
    pub gm: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_SESSION, session_id.as_bytes()],
        bump = session.bump
    )]
    pub session: Account<'info, Session>,
}
