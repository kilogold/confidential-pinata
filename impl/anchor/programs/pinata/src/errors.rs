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
    #[msg("pubkey-validity proof instruction is required to create the HP vault")]
    MissingPubkeyValidityProof,
    #[msg("proof instruction offsets must reference preceding instructions")]
    InvalidProofInstructionOffset,
    #[msg("HP mint is not a confidential Token-2022 mint")]
    InvalidHpMint,
    #[msg("arbiter must be the HP mint authority")]
    InvalidArbiterMintAuthority,
    #[msg("Token-2022 CPI failed")]
    Token2022Cpi,
    #[msg("reinitialize is not implemented")]
    ReinitializeNotImplemented,
}
