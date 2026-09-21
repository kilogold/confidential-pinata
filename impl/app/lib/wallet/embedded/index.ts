import { getAddressEncoder } from "@solana/kit";
import type { WalletConnector } from "../types";
import { fundEmbeddedWallets } from "./fund";
import { signAndSendEmbeddedTransaction } from "./send";
import { loadOrCreateEmbeddedSigner, type EmbeddedRole } from "./storage";

let fundingStarted = false;

function createEmbeddedConnector(role: EmbeddedRole): WalletConnector {
  const name = role === "gm" ? "Local GM" : "Local Player";
  const metadata = { id: `embedded:${role}`, name };

  return {
    ...metadata,
    autoConnect: false,
    connect: async () => {
      if (process.env.NODE_ENV !== "development") {
        throw new Error(
          "Local wallets are only available in development builds"
        );
      }
      const signer = await loadOrCreateEmbeddedSigner(role);
      return {
        account: {
          address: signer.address,
          publicKey: new Uint8Array(getAddressEncoder().encode(signer.address)),
          label: name,
        },
        connector: metadata,
        supportedTransactionVersions: [1],
        disconnect: async () => {},
        sendTransaction: (transaction: Uint8Array, chain: string) =>
          signAndSendEmbeddedTransaction(transaction, chain, signer),
      };
    },
  };
}

export function getEmbeddedConnectors(): WalletConnector[] {
  return [createEmbeddedConnector("gm"), createEmbeddedConnector("player")];
}

export function orchestrateEmbeddedWallets(
  setConnectors: (connectors: WalletConnector[]) => void
): void {
  if (process.env.NODE_ENV !== "development") return;

  setConnectors(getEmbeddedConnectors());
  if (fundingStarted) return;
  fundingStarted = true;
  void fundEmbeddedWallets().catch((cause: unknown) => {
    console.warn("Embedded wallet Surfpool funding failed:", cause);
  });
}
