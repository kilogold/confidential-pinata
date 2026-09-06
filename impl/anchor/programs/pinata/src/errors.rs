use anchor_lang::prelude::*;

#[error_code]
pub enum PinataError {
    #[msg("piñata already exists")]
    PinataAlreadyExists,
    #[msg("session_id must be 1 to 24 bytes")]
    InvalidSessionId,
    #[msg("strike fee must be greater than zero")]
    InvalidStrikeFee,
    #[msg("reward amount must be greater than zero")]
    InvalidRewardAmount,
    #[msg("zero-proof context is required to re-initialize")]
    MissingZeroProof,
    #[msg("zero-proof context is invalid")]
    InvalidZeroProof,
    #[msg("zero-proof does not match this HP vault")]
    ZeroProofMismatch,
    #[msg("reward_vault must be empty or closed to re-initialize")]
    RewardVaultNotEmpty,
    #[msg("sol_pile must be empty or closed to re-initialize")]
    SolPileNotEmpty,
    #[msg("pubkey-validity proof context is required to create the HP vault")]
    MissingPubkeyValidityProof,
    #[msg("HP mint is not a confidential Token-2022 mint")]
    InvalidHpMint,
    #[msg("arbiter must be the HP mint authority")]
    InvalidArbiterMintAuthority,
    #[msg("Token-2022 CPI failed")]
    Token2022Cpi,
}
