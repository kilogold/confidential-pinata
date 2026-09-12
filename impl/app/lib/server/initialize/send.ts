import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { InitializeApiError } from "./errors";
import type { SolanaRpc } from "../rpc";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendAndConfirmInstructions(
  rpc: SolanaRpc,
  payer: TransactionSigner,
  instructions: Instruction[]
): Promise<string> {
  if (instructions.length === 0) {
    throw new InitializeApiError(
      "PROOF_SETUP_FAILED",
      "No proof-setup instructions to send",
      { status: 500 }
    );
  }

  let blockhash;
  try {
    ({ value: blockhash } = await rpc.getLatestBlockhash().send());
  } catch {
    throw new InitializeApiError(
      "RPC_UNAVAILABLE",
      "Could not fetch a recent blockhash",
      { status: 502 }
    );
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  let signed;
  try {
    signed = await signTransactionMessageWithSigners(message);
  } catch (err) {
    throw new InitializeApiError(
      "PROOF_SETUP_FAILED",
      err instanceof Error
        ? err.message
        : "Failed to sign proof-setup transaction",
      { status: 500 }
    );
  }

  const wire = getBase64EncodedWireTransaction(signed);
  let signature: string;
  try {
    signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  } catch (err) {
    throw new InitializeApiError(
      "PROOF_SETUP_FAILED",
      err instanceof Error
        ? err.message
        : "Failed to send proof-setup transaction",
      { status: 502 }
    );
  }

  const sig = getSignatureFromTransaction(signed);
  for (let i = 0; i < 40; i += 1) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const status = value[0];
    if (status?.err) {
      throw new InitializeApiError(
        "PROOF_SETUP_FAILED",
        "Proof-setup transaction failed on chain",
        { status: 502 }
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    await sleep(400);
  }

  throw new InitializeApiError(
    "PROOF_SETUP_FAILED",
    "Timed out waiting for proof-setup confirmation",
    { status: 504 }
  );
}
