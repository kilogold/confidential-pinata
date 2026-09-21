"use client";

import { useCallback, useState } from "react";
import {
  createSolanaRpc,
  getBase58Decoder,
  signature,
  type Signature,
} from "@solana/kit";
import { useCluster } from "../../components/cluster-context";
import { getClusterUrl } from "../solana-client";
import { useWallet } from "../wallet/context";

const TRANSACTION_V1_PREFIX = 0x81;
const CONFIRMATION_POLL_INTERVAL_MS = 400;
const CONFIRMATION_TIMEOUT_MS = 90_000;

export type PreparedTransaction = {
  transaction: string;
  lastValidBlockHeight: string;
};

export type TransactionProgress = {
  phase: "awaiting-wallet" | "confirming";
};

function getTransactionDebugInfo(bytes: Uint8Array) {
  return {
    byteLength: bytes.byteLength,
    firstBytes: Array.from(bytes.slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(" "),
    versionPrefix: `0x${(bytes[0] ?? 0).toString(16).padStart(2, "0")}`,
  };
}

function decodeBase64Transaction(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Initialize returned a malformed transaction");
  }
  if (binary.length === 0) {
    throw new Error("Initialize returned an empty transaction");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytes[0] !== TRANSACTION_V1_PREFIX) {
    throw new Error("Initialize did not return a transaction-v1 payload");
  }
  return bytes;
}

function parseLastValidBlockHeight(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error("Initialize returned an invalid blockhash lifetime");
  }
  return BigInt(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePreparedTransaction(value: unknown): PreparedTransaction {
  if (!value || typeof value !== "object") {
    throw new Error("Initialize returned an invalid transaction");
  }
  const candidate = value as Partial<PreparedTransaction>;
  if (
    typeof candidate.transaction !== "string" ||
    typeof candidate.lastValidBlockHeight !== "string"
  ) {
    throw new Error("Initialize returned an invalid transaction");
  }
  const bytes = decodeBase64Transaction(candidate.transaction);
  parseLastValidBlockHeight(candidate.lastValidBlockHeight);
  console.info("Received prepared Initialize transaction", {
    base64Length: candidate.transaction.length,
    lastValidBlockHeight: candidate.lastValidBlockHeight,
    ...getTransactionDebugInfo(bytes),
  });
  return {
    transaction: candidate.transaction,
    lastValidBlockHeight: candidate.lastValidBlockHeight,
  };
}

export function useSignAndSendPartialTransaction() {
  const { wallet } = useWallet();
  const { cluster } = useCluster();
  const [isSending, setIsSending] = useState(false);
  const [progress, setProgress] = useState<TransactionProgress | null>(null);

  const signAndSend = useCallback(
    async (prepared: PreparedTransaction): Promise<Signature> => {
      if (!wallet) {
        throw new Error("Wallet not connected");
      }
      if (!wallet.supportedTransactionVersions.includes(1)) {
        throw new Error("This wallet does not support Solana transaction v1");
      }
      if (!wallet.sendTransaction) {
        throw new Error(
          "This wallet cannot sign and send transactions through its own RPC"
        );
      }

      const bytes = decodeBase64Transaction(prepared.transaction);
      const lastValidBlockHeight = parseLastValidBlockHeight(
        prepared.lastValidBlockHeight
      );
      const rpc = createSolanaRpc(getClusterUrl(cluster));
      const chain = `solana:${cluster}`;

      setIsSending(true);
      try {
        const blockHeight = await rpc.getBlockHeight().send();
        if (blockHeight > lastValidBlockHeight) {
          throw new Error("The prepared transaction has expired");
        }

        setProgress({ phase: "awaiting-wallet" });
        console.info("Submitting prepared Initialize transaction to wallet", {
          chain,
          lastValidBlockHeight: lastValidBlockHeight.toString(),
          ...getTransactionDebugInfo(bytes),
        });
        const signatureBytes = await wallet.sendTransaction(bytes, chain);
        const transactionSignature = signature(
          getBase58Decoder().decode(signatureBytes)
        );

        setProgress({ phase: "confirming" });
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
            return transactionSignature;
          }

          const currentBlockHeight = await rpc.getBlockHeight().send();
          if (currentBlockHeight > lastValidBlockHeight) {
            throw new Error("Transaction expired before confirmation");
          }
          if (Date.now() - confirmationStartedAt >= CONFIRMATION_TIMEOUT_MS) {
            throw new Error("Timed out waiting for transaction confirmation");
          }
          await sleep(CONFIRMATION_POLL_INTERVAL_MS);
        }
      } finally {
        setIsSending(false);
        setProgress(null);
      }
    },
    [wallet, cluster]
  );

  return { signAndSend, isSending, progress };
}
