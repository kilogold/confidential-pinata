"use client";

import { useState, useCallback, useMemo } from "react";
import { useSWRConfig } from "swr";
import { createClient, type Instruction } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { payer } from "@solana/kit-plugin-signer";
import { useWallet } from "../wallet/context";
import { useCluster } from "../../components/cluster-context";
import { getClusterUrl, getClusterWsConfig } from "../solana-client";

export function useSendTransaction() {
  const { signer } = useWallet();
  const { cluster } = useCluster();
  const { mutate } = useSWRConfig();
  const [isSending, setIsSending] = useState(false);

  const txClient = useMemo(() => {
    if (!signer) return null;
    const ws = getClusterWsConfig(cluster);
    const rpcOptions: { rpcUrl: string; rpcSubscriptionsUrl?: string } = {
      rpcUrl: getClusterUrl(cluster),
    };
    // Localnet WS is :8900; Kit's http→ws rewrite would keep :8899.
    if (ws?.url) {
      rpcOptions.rpcSubscriptionsUrl = ws.url;
    }
    return createClient().use(payer(signer)).use(solanaRpc(rpcOptions));
  }, [cluster, signer]);

  const send = useCallback(
    async ({ instructions }: { instructions: readonly Instruction[] }) => {
      if (!txClient) throw new Error("Wallet not connected");

      setIsSending(true);
      try {
        const result = await txClient.sendTransaction([...instructions]);
        mutate((key: unknown) => Array.isArray(key) && key[0] === "balance");
        return result.context.signature;
      } finally {
        setIsSending(false);
      }
    },
    [txClient, mutate]
  );

  return { send, isSending };
}
