"use client";

import { useCallback, useState } from "react";
import {
  createSolanaRpc,
  getBase64Decoder,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { useWallet } from "../wallet/context";
import { useCluster } from "../../components/cluster-context";
import { getClusterUrl } from "../solana-client";

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Completes a backend-partial-signed wire transaction.
 * Prefer Wallet Standard `signAndSendTransaction` (F0). Fallback is
 * `signTransaction` then send on the selected cluster RPC.
 */
export function useSignAndSendPartialTransaction() {
  const { wallet } = useWallet();
  const { cluster } = useCluster();
  const [isSending, setIsSending] = useState(false);

  const signAndSend = useCallback(
    async (base64Transaction: string) => {
      if (!wallet) {
        throw new Error("Wallet not connected");
      }
      const chain = `solana:${cluster}`;
      const bytes = decodeBase64Bytes(base64Transaction);
      setIsSending(true);
      try {
        if (wallet.sendTransaction) {
          await wallet.sendTransaction(bytes, chain);
          return;
        }
        if (!wallet.signTransaction) {
          throw new Error("Wallet cannot sign or send transactions");
        }
        const signed = await wallet.signTransaction(bytes, chain);
        const rpc = createSolanaRpc(getClusterUrl(cluster));
        const wire = getBase64Decoder().decode(
          signed
        ) as Base64EncodedWireTransaction;
        await rpc.sendTransaction(wire, { encoding: "base64" }).send();
      } finally {
        setIsSending(false);
      }
    },
    [wallet, cluster]
  );

  return { signAndSend, isSending };
}
