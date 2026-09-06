use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};
use bytemuck::{bytes_of, pod_read_unaligned, Pod};
use solana_address::Address;
use spl_token_2022_interface::{
    extension::{
        confidential_mint_burn::{
            instruction::{ConfidentialMintBurnInstruction, MintInstructionData},
            ConfidentialMintBurn,
        },
        confidential_transfer::{
            instruction::{
                ApplyPendingBalanceData, ConfidentialTransferInstruction,
                ConfigureAccountInstructionData,
            },
            ConfidentialTransferAccount, ConfidentialTransferMint, DecryptableBalance,
            DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
        },
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction::{initialize_account3, reallocate, TokenInstruction},
    state::{Account as TokenAccountState, Mint as TokenMint},
};

use crate::errors::PinataError;

const TOKEN_ACCOUNT_BASE_LEN: usize = 165;

const ZERO_CIPHERTEXT_PROOF_TYPE: u8 = 1;
const ZERO_PROOF_CONTEXT_LEN: usize = 129;

pub fn needs_hp_vault_create(hp_vault: &AccountInfo) -> bool {
    hp_vault.lamports() == 0
        || hp_vault.data_is_empty()
        || hp_vault.owner == &anchor_lang::system_program::ID
}

pub fn assert_hp_mint(hp_mint: &AccountInfo, arbiter: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *hp_mint.owner,
        spl_token_2022_interface::id(),
        PinataError::InvalidHpMint
    );
    let data = hp_mint.try_borrow_data()?;
    let mint = StateWithExtensions::<TokenMint>::unpack(&data)
        .map_err(|_| error!(PinataError::InvalidHpMint))?;
    let mint_authority = match mint.base.mint_authority {
        solana_program_option::COption::Some(key) => key,
        solana_program_option::COption::None => {
            return err!(PinataError::InvalidArbiterMintAuthority)
        }
    };
    require!(
        mint_authority.as_ref() == arbiter.as_ref(),
        PinataError::InvalidArbiterMintAuthority
    );
    mint.get_extension::<ConfidentialTransferMint>()
        .map_err(|_| error!(PinataError::InvalidHpMint))?;
    mint.get_extension::<ConfidentialMintBurn>()
        .map_err(|_| error!(PinataError::InvalidHpMint))?;
    Ok(())
}

pub fn bind_zero_proof(zero_proof: &AccountInfo, hp_vault: &AccountInfo) -> Result<()> {
    let proof_data = zero_proof.try_borrow_data()?;
    require!(
        proof_data.len() >= ZERO_PROOF_CONTEXT_LEN,
        PinataError::InvalidZeroProof
    );
    require!(
        proof_data[32] == ZERO_CIPHERTEXT_PROOF_TYPE,
        PinataError::InvalidZeroProof
    );
    let proof_pubkey = &proof_data[33..65];
    let proof_ciphertext = &proof_data[65..129];

    let vault_data = hp_vault.try_borrow_data()?;
    let vault = StateWithExtensions::<TokenAccountState>::unpack(&vault_data)
        .map_err(|_| error!(PinataError::InvalidZeroProof))?;
    let ct = vault
        .get_extension::<ConfidentialTransferAccount>()
        .map_err(|_| error!(PinataError::InvalidZeroProof))?;

    require!(
        proof_pubkey == bytes_of(&ct.elgamal_pubkey),
        PinataError::ZeroProofMismatch
    );
    require!(
        proof_ciphertext == bytes_of(&ct.available_balance),
        PinataError::ZeroProofMismatch
    );
    Ok(())
}

pub fn create_hp_vault<'info>(
    gm: &AccountInfo<'info>,
    arbiter: &AccountInfo<'info>,
    hp_vault: &AccountInfo<'info>,
    hp_mint: &AccountInfo<'info>,
    pubkey_validity_proof: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    decryptable_zero: &[u8; 36],
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let space = TOKEN_ACCOUNT_BASE_LEN;
    let lamports = Rent::get()?.minimum_balance(space);

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            gm.key,
            hp_vault.key,
            lamports,
            space as u64,
            token_2022_program.key,
        ),
        &[gm.clone(), hp_vault.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    let init_ix = initialize_account3(
        &as_address(token_2022_program.key),
        &as_address(hp_vault.key),
        &as_address(hp_mint.key),
        &as_address(arbiter.key),
    )
    .map_err(|_| error!(PinataError::Token2022Cpi))?;
    invoke(
        &from_interface_ix(init_ix),
        &[
            hp_vault.clone(),
            hp_mint.clone(),
            token_2022_program.clone(),
        ],
    )?;

    let realloc_ix = reallocate(
        &as_address(token_2022_program.key),
        &as_address(hp_vault.key),
        &as_address(gm.key),
        &as_address(arbiter.key),
        &[],
        &[ExtensionType::ConfidentialTransferAccount],
    )
    .map_err(|_| error!(PinataError::Token2022Cpi))?;
    invoke(
        &from_interface_ix(realloc_ix),
        &[
            hp_vault.clone(),
            gm.clone(),
            system_program.clone(),
            arbiter.clone(),
            token_2022_program.clone(),
        ],
    )?;

    let decryptable_zero_balance: DecryptableBalance = pod_read_unaligned(decryptable_zero);
    let configure_data = ConfigureAccountInstructionData {
        decryptable_zero_balance,
        maximum_pending_balance_credit_counter: DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER
            .into(),
        proof_instruction_offset: 0,
    };
    let configure_ix = extension_ix(
        token_2022_program.key,
        vec![
            AccountMeta::new(*hp_vault.key, false),
            AccountMeta::new_readonly(*hp_mint.key, false),
            AccountMeta::new_readonly(*pubkey_validity_proof.key, false),
            AccountMeta::new_readonly(*arbiter.key, true),
        ],
        TokenInstruction::ConfidentialTransferExtension,
        ConfidentialTransferInstruction::ConfigureAccount as u8,
        &configure_data,
    );
    invoke(
        &configure_ix,
        &[
            hp_vault.clone(),
            hp_mint.clone(),
            pubkey_validity_proof.clone(),
            arbiter.clone(),
            token_2022_program.clone(),
        ],
    )?;

    Ok(())
}

pub fn confidential_mint<'info>(
    hp_vault: &AccountInfo<'info>,
    hp_mint: &AccountInfo<'info>,
    arbiter: &AccountInfo<'info>,
    equality_proof: &AccountInfo<'info>,
    ciphertext_validity_proof: &AccountInfo<'info>,
    range_proof: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    new_decryptable_supply: &[u8; 36],
    mint_amount_auditor_ciphertext_lo: &[u8; 64],
    mint_amount_auditor_ciphertext_hi: &[u8; 64],
) -> Result<()> {
    let data = MintInstructionData {
        new_decryptable_supply: pod_read_unaligned(new_decryptable_supply),
        mint_amount_auditor_ciphertext_lo: pod_read_unaligned(mint_amount_auditor_ciphertext_lo),
        mint_amount_auditor_ciphertext_hi: pod_read_unaligned(mint_amount_auditor_ciphertext_hi),
        equality_proof_instruction_offset: 0,
        ciphertext_validity_proof_instruction_offset: 0,
        range_proof_instruction_offset: 0,
    };
    let mint_ix = extension_ix(
        token_2022_program.key,
        vec![
            AccountMeta::new(*hp_vault.key, false),
            AccountMeta::new(*hp_mint.key, false),
            AccountMeta::new_readonly(*equality_proof.key, false),
            AccountMeta::new_readonly(*ciphertext_validity_proof.key, false),
            AccountMeta::new_readonly(*range_proof.key, false),
            AccountMeta::new_readonly(*arbiter.key, true),
        ],
        TokenInstruction::ConfidentialMintBurnExtension,
        ConfidentialMintBurnInstruction::Mint as u8,
        &data,
    );
    invoke(
        &mint_ix,
        &[
            hp_vault.clone(),
            hp_mint.clone(),
            equality_proof.clone(),
            ciphertext_validity_proof.clone(),
            range_proof.clone(),
            arbiter.clone(),
            token_2022_program.clone(),
        ],
    )
    .map_err(|_| error!(PinataError::Token2022Cpi))?;
    Ok(())
}

pub fn apply_pending_balance_cpi<'info>(
    hp_vault: &AccountInfo<'info>,
    arbiter: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    expected_pending_balance_credit_counter: u64,
    new_decryptable_available_balance: &[u8; 36],
) -> Result<()> {
    let data = ApplyPendingBalanceData {
        expected_pending_balance_credit_counter: expected_pending_balance_credit_counter.into(),
        new_decryptable_available_balance: pod_read_unaligned(new_decryptable_available_balance),
    };
    let apply_ix = extension_ix(
        token_2022_program.key,
        vec![
            AccountMeta::new(*hp_vault.key, false),
            AccountMeta::new_readonly(*arbiter.key, true),
        ],
        TokenInstruction::ConfidentialTransferExtension,
        ConfidentialTransferInstruction::ApplyPendingBalance as u8,
        &data,
    );
    invoke(
        &apply_ix,
        &[
            hp_vault.clone(),
            arbiter.clone(),
            token_2022_program.clone(),
        ],
    )
    .map_err(|_| error!(PinataError::Token2022Cpi))?;
    Ok(())
}

pub fn transfer_reward<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let ix = spl_token_2022_interface::instruction::transfer_checked(
        &as_address(token_program.key),
        &as_address(source.key),
        &as_address(mint.key),
        &as_address(destination.key),
        &as_address(authority.key),
        &[],
        amount,
        decimals,
    )
    .map_err(|_| error!(PinataError::Token2022Cpi))?;
    invoke(
        &from_interface_ix(ix),
        &[
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
    )?;
    Ok(())
}

fn as_address(key: &Pubkey) -> Address {
    Address::new_from_array(key.to_bytes())
}

fn from_interface_ix(ix: solana_instruction::Instruction) -> Instruction {
    Instruction {
        program_id: Pubkey::new_from_array(ix.program_id.to_bytes()),
        accounts: ix
            .accounts
            .into_iter()
            .map(|meta| AccountMeta {
                pubkey: Pubkey::new_from_array(meta.pubkey.to_bytes()),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: ix.data,
    }
}

fn extension_ix<D: Pod>(
    program_id: &Pubkey,
    accounts: Vec<AccountMeta>,
    token_instruction: TokenInstruction,
    extension_instruction: u8,
    extension_data: &D,
) -> Instruction {
    let mut data = token_instruction.pack();
    data.push(extension_instruction);
    data.extend_from_slice(bytes_of(extension_data));
    Instruction {
        program_id: *program_id,
        accounts,
        data,
    }
}
