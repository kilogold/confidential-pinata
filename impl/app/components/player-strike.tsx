"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  parsePreparedTransaction,
  useSignAndSendPartialTransaction,
} from "../lib/hooks/use-sign-and-send-partial-transaction";
import { useWallet } from "../lib/wallet/context";

type StrikeErrorBody = {
  error?: { message?: string };
};

export function PlayerStrike({ enabled }: { enabled: boolean }) {
  const { wallet } = useWallet();
  const { signAndSend, isSending, progress } =
    useSignAndSendPartialTransaction();
  const [sessionId, setSessionId] = useState("test");
  const [isRequesting, setIsRequesting] = useState(false);
  const busy = isRequesting || isSending;

  async function onStrike() {
    if (!wallet || busy) return;
    if (!wallet.supportedTransactionVersions.includes(1)) {
      toast.error("This wallet does not support Solana transaction v1");
      return;
    }

    setIsRequesting(true);
    try {
      const response = await fetch("/api/attack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attacker: wallet.account.address,
          sessionId,
        }),
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const err = json as StrikeErrorBody;
        toast.error(err.error?.message ?? "Strike failed");
        return;
      }
      await signAndSend(parsePreparedTransaction(json));
      toast.success("Strike confirmed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Strike failed");
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium tracking-tight text-muted">Player</h2>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Session ID
        <input
          type="text"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          autoComplete="off"
          className="rounded-lg border border-neutral-400 bg-card px-3 py-2 text-sm text-foreground dark:border-neutral-600"
        />
      </label>
      <button
        type="button"
        disabled={!enabled || busy}
        onClick={() => void onStrike()}
        className="rounded-lg border border-neutral-400 bg-card px-5 py-2.5 text-sm font-medium shadow-xs transition enabled:hover:border-neutral-600 enabled:hover:bg-cream disabled:pointer-events-none dark:border-neutral-600 dark:enabled:hover:border-neutral-500"
      >
        {progress?.phase === "awaiting-wallet"
          ? "Submitting…"
          : progress?.phase === "confirming"
            ? "Confirming…"
            : busy
              ? "Preparing…"
              : "Strike"}
      </button>
    </section>
  );
}
