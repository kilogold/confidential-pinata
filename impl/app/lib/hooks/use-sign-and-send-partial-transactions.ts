"use client";

import { useCallback, useState } from "react";
import {
  createSolanaRpc,
  getBase58Decoder,
  signature,
  type Base64EncodedWireTransaction,
  type Signature,
} from "@solana/kit";
import { useWallet } from "../wallet/context";
import { useCluster } from "../../components/cluster-context";
import { getClusterUrl } from "../solana-client";

const CONFIRMATION_POLL_INTERVAL_MS = 400;
const CONFIRMATION_TIMEOUT_MS = 90_000;

export type PreparedTransactionSequence = {
  transactions: string[];
  lastValidBlockHeight: string;
};

export type TransactionSequenceProgress = {
  current: number;
  total: number;
  completed: number;
  phase: "simulating" | "awaiting-wallet" | "confirming";
};

export class TransactionSequenceError extends Error {
  readonly transactionIndex: number;
  readonly transactionCount: number;
  readonly completedTransactions: number;

  constructor(
    message: string,
    transactionIndex: number,
    transactionCount: number,
    completedTransactions: number
  ) {
    super(
      `Transaction ${transactionIndex} of ${transactionCount} failed after ${completedTransactions} confirmed: ${message}`
    );
    this.name = "TransactionSequenceError";
    this.transactionIndex = transactionIndex;
    this.transactionCount = transactionCount;
    this.completedTransactions = completedTransactions;
  }
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  if (binary.length === 0) {
    throw new Error("Transaction payload is empty");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseLastValidBlockHeight(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error("Initialize returned an invalid blockhash lifetime");
  }
  return BigInt(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown transaction error";
}

function simulationErrorMessage(err: unknown, logs?: readonly string[] | null) {
  const detail = typeof err === "string" ? err : JSON.stringify(err);
  const joinedLogs = logs?.join("\n") ?? "";
  return joinedLogs.length > 0
    ? `Simulation failed (${detail}): ${joinedLogs.slice(-500)}`
    : `Simulation failed: ${detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePreparedTransactionSequence(
  value: unknown
): PreparedTransactionSequence {
  if (!value || typeof value !== "object") {
    throw new Error("Initialize returned an invalid transaction sequence");
  }
  const candidate = value as Partial<PreparedTransactionSequence>;
  if (
    !Array.isArray(candidate.transactions) ||
    candidate.transactions.length === 0 ||
    candidate.transactions.some(
      (transaction) =>
        typeof transaction !== "string" || transaction.length === 0
    ) ||
    typeof candidate.lastValidBlockHeight !== "string"
  ) {
    throw new Error("Initialize returned an invalid transaction sequence");
  }
  parseLastValidBlockHeight(candidate.lastValidBlockHeight);
  return {
    transactions: candidate.transactions,
    lastValidBlockHeight: candidate.lastValidBlockHeight,
  };
}

export function useSignAndSendPartialTransactions() {
  const { wallet } = useWallet();
  const { cluster } = useCluster();
  const [isSending, setIsSending] = useState(false);
  const [progress, setProgress] = useState<TransactionSequenceProgress | null>(
    null
  );

  const signAndSend = useCallback(
    async (sequence: PreparedTransactionSequence): Promise<Signature[]> => {
      if (!wallet) {
        throw new Error("Wallet not connected");
      }
      if (!wallet.sendTransaction) {
        throw new Error(
          "This wallet cannot sign and send transactions through its own RPC"
        );
      }

      const total = sequence.transactions.length;
      if (total === 0) {
        throw new Error("Initialize returned no transactions");
      }
      const lastValidBlockHeight = parseLastValidBlockHeight(
        sequence.lastValidBlockHeight
      );
      const chain = `solana:${cluster}`;
      const rpc = createSolanaRpc(getClusterUrl(cluster));
      const signatures: Signature[] = [];

      setIsSending(true);
      try {
        for (let offset = 0; offset < total; offset += 1) {
          const current = offset + 1;
          try {
            const base64Transaction = sequence.transactions[offset]!;
            const bytes = decodeBase64Bytes(base64Transaction);
            const blockHeight = await rpc.getBlockHeight().send();
            if (blockHeight > lastValidBlockHeight) {
              throw new Error("The prepared transaction sequence has expired");
            }

            setProgress({
              current,
              total,
              completed: offset,
              phase: "simulating",
            });
            const simulation = await rpc
              .simulateTransaction(
                base64Transaction as Base64EncodedWireTransaction,
                {
                  encoding: "base64",
                  sigVerify: false,
                }
              )
              .send();
            if (simulation.value.err) {
              throw new Error(
                simulationErrorMessage(
                  simulation.value.err,
                  simulation.value.logs
                )
              );
            }

            setProgress({
              current,
              total,
              completed: offset,
              phase: "awaiting-wallet",
            });
            const signatureBytes = await wallet.sendTransaction(bytes, chain);
            const transactionSignature = signature(
              getBase58Decoder().decode(signatureBytes)
            );

            setProgress({
              current,
              total,
              completed: offset,
              phase: "confirming",
            });
            const confirmationStartedAt = Date.now();
            for (;;) {
              const { value } = await rpc
                .getSignatureStatuses([transactionSignature])
                .send();
              const status = value[0];
              if (status?.err) {
                throw new Error(
                  `Transaction failed on chain: ${JSON.stringify(status.err)}`
                );
              }
              if (
                status?.confirmationStatus === "confirmed" ||
                status?.confirmationStatus === "finalized"
              ) {
                break;
              }

              const currentBlockHeight = await rpc.getBlockHeight().send();
              if (currentBlockHeight > lastValidBlockHeight) {
                throw new Error(
                  "Transaction expired before confirmation was observed"
                );
              }
              if (
                Date.now() - confirmationStartedAt >=
                CONFIRMATION_TIMEOUT_MS
              ) {
                throw new Error(
                  "Timed out waiting for transaction confirmation"
                );
              }
              await sleep(CONFIRMATION_POLL_INTERVAL_MS);
            }
            signatures.push(transactionSignature);
          } catch (err) {
            if (err instanceof TransactionSequenceError) throw err;
            throw new TransactionSequenceError(
              errorMessage(err),
              current,
              total,
              offset
            );
          }
        }
        return signatures;
      } finally {
        setIsSending(false);
        setProgress(null);
      }
    },
    [wallet, cluster]
  );

  return { signAndSend, isSending, progress };
}
