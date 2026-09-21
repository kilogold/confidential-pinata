import assert from "node:assert/strict";
import { test } from "node:test";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  appendTransactionMessageInstruction,
  blockhash,
  bytesEqual,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { signAndSendEmbeddedTransaction } from "./send";

type LocalRpc = Parameters<typeof signAndSendEmbeddedTransaction>[3];

async function preparedTransaction(
  payer: KeyPairSigner,
  arbiter: KeyPairSigner
) {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (value) =>
      setTransactionMessageFeePayerSigner(
        createNoopSigner(payer.address),
        value
      ),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash("11111111111111111111111111111111"),
          lastValidBlockHeight: 100n,
        },
        value
      ),
    (value) =>
      appendTransactionMessageInstruction(
        getTransferSolInstruction({
          source: arbiter,
          destination: payer.address,
          amount: lamports(1n),
        }),
        value
      ),
    (value) =>
      setTransactionMessageConfig(
        { computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 32_768 },
        value
      )
  );
  const partial = await partiallySignTransactionMessageWithSigners(message);
  const bytes = new Uint8Array(
    getBase64Encoder().encode(getBase64EncodedWireTransaction(partial))
  );
  return { partial, bytes };
}

function rpcStub(options?: { simulationError?: unknown }) {
  const events: string[] = [];
  let submitted: Transaction | undefined;
  const rpc = {
    simulateTransaction: (wire: string, config: object) => {
      events.push("simulate");
      assert.deepEqual(config, { encoding: "base64", sigVerify: true });
      submitted = getTransactionDecoder().decode(
        getBase64Encoder().encode(wire)
      );
      return {
        send: async () => ({
          value: {
            err: options?.simulationError ?? null,
            logs: ["simulated"],
          },
        }),
      };
    },
    sendTransaction: (wire: string, config: object) => {
      events.push("send");
      assert.deepEqual(config, { encoding: "base64", skipPreflight: false });
      const decoded = getTransactionDecoder().decode(
        getBase64Encoder().encode(wire)
      );
      assert.ok(submitted);
      assert.ok(bytesEqual(submitted.messageBytes, decoded.messageBytes));
      return { send: async () => getSignatureFromTransaction(decoded) };
    },
  } as unknown as LocalRpc;
  return { rpc, events, getSubmitted: () => submitted };
}

test("embedded signer preserves the arbiter signature and simulates before sending on the selected cluster", async () => {
  const payer = await generateKeyPairSigner();
  const arbiter = await generateKeyPairSigner();
  const { partial, bytes } = await preparedTransaction(payer, arbiter);
  const { rpc, events, getSubmitted } = rpcStub();

  const signatureBytes = await signAndSendEmbeddedTransaction(
    bytes,
    "solana:devnet",
    payer,
    rpc
  );
  const sent = getSubmitted();
  assert.ok(sent);
  assert.deepEqual(events, ["simulate", "send"]);
  assert.ok(bytesEqual(sent.messageBytes, partial.messageBytes));
  assert.ok(
    bytesEqual(
      sent.signatures[arbiter.address]!,
      partial.signatures[arbiter.address]!
    )
  );
  assert.ok(sent.signatures[payer.address]);
  assert.equal(
    getBase58Decoder().decode(signatureBytes),
    getSignatureFromTransaction(sent)
  );
});

test("embedded signer rejects unknown chains and malformed payloads before RPC", async () => {
  const payer = await generateKeyPairSigner();
  const arbiter = await generateKeyPairSigner();
  const { bytes } = await preparedTransaction(payer, arbiter);
  const { rpc, events } = rpcStub();

  await assert.rejects(
    signAndSendEmbeddedTransaction(bytes, "solana:unknown", payer, rpc),
    /Unsupported Solana cluster/
  );
  await assert.rejects(
    signAndSendEmbeddedTransaction(
      new Uint8Array([0]),
      "solana:localnet",
      payer,
      rpc
    ),
    /transaction-v1 payload/
  );
  await assert.rejects(
    signAndSendEmbeddedTransaction(
      new Uint8Array([0x81]),
      "solana:localnet",
      payer,
      rpc
    ),
    /malformed transaction-v1 payload/
  );
  assert.deepEqual(events, []);
});

test("local signer rejects a different fee payer or missing arbiter signature", async () => {
  const payer = await generateKeyPairSigner();
  const other = await generateKeyPairSigner();
  const arbiter = await generateKeyPairSigner();
  const { partial, bytes } = await preparedTransaction(payer, arbiter);
  const { rpc, events } = rpcStub();

  await assert.rejects(
    signAndSendEmbeddedTransaction(bytes, "solana:localnet", other, rpc),
    /does not match the transaction fee payer/
  );

  const withoutArbiter = getBase64EncodedWireTransaction({
    ...partial,
    signatures: { ...partial.signatures, [arbiter.address]: null },
  });
  await assert.rejects(
    signAndSendEmbeddedTransaction(
      new Uint8Array(getBase64Encoder().encode(withoutArbiter)),
      "solana:localnet",
      payer,
      rpc
    ),
    /missing an arbiter signature/
  );
  assert.deepEqual(events, []);
});

test("a failed simulation prevents submission", async () => {
  const payer = await generateKeyPairSigner();
  const arbiter = await generateKeyPairSigner();
  const { bytes } = await preparedTransaction(payer, arbiter);
  const { rpc, events } = rpcStub({
    simulationError: { InstructionError: [0, "Custom"] },
  });

  await assert.rejects(
    signAndSendEmbeddedTransaction(bytes, "solana:localnet", payer, rpc),
    /Embedded wallet simulation failed/
  );
  assert.deepEqual(events, ["simulate"]);
});
