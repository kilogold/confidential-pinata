import {
  assertIsTransactionWithinSizeLimit,
  bytesEqual,
  createSolanaRpc,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  CLUSTERS,
  getClusterUrl,
  type ClusterMoniker,
} from "../../solana-client";

type LocalRpc = Pick<
  ReturnType<typeof createSolanaRpc>,
  "simulateTransaction" | "sendTransaction"
>;

const TRANSACTION_V1_PREFIX = 0x81;

export async function signAndSendEmbeddedTransaction(
  bytes: Uint8Array,
  chain: string,
  signer: KeyPairSigner,
  rpc?: LocalRpc
): Promise<Uint8Array> {
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "Embedded wallets are only available in development builds"
    );
  }
  const cluster = chain.startsWith("solana:")
    ? (chain.slice("solana:".length) as ClusterMoniker)
    : undefined;
  if (!cluster || !CLUSTERS.includes(cluster)) {
    throw new Error(`Unsupported Solana cluster: ${chain}`);
  }
  if (bytes[0] !== TRANSACTION_V1_PREFIX) {
    throw new Error("Local wallet requires a transaction-v1 payload");
  }

  let partial;
  let compiledMessage;
  try {
    partial = getTransactionDecoder().decode(bytes);
    compiledMessage = getCompiledTransactionMessageDecoder().decode(
      partial.messageBytes
    );
  } catch {
    throw new Error("Local wallet received a malformed transaction-v1 payload");
  }
  if (compiledMessage.version !== 1) {
    throw new Error("Local wallet requires a transaction-v1 message");
  }
  if (compiledMessage.staticAccounts[0] !== signer.address) {
    throw new Error(
      "Local wallet address does not match the transaction fee payer"
    );
  }
  if (partial.signatures[signer.address] !== null) {
    throw new Error("Local wallet fee-payer signature slot is not empty");
  }

  const arbiterSignatures = Object.entries(partial.signatures).filter(
    ([address]) => address !== signer.address
  );
  if (
    arbiterSignatures.length === 0 ||
    arbiterSignatures.some(([, signature]) => signature === null)
  ) {
    throw new Error("Prepared transaction is missing an arbiter signature");
  }

  const signed = await signTransaction([signer.keyPair], partial);
  if (!bytesEqual(signed.messageBytes, partial.messageBytes)) {
    throw new Error("Local wallet changed the prepared transaction message");
  }
  for (const [address, existingSignature] of arbiterSignatures) {
    const signedSignature = signed.signatures[address as Address];
    if (
      existingSignature === null ||
      signedSignature === null ||
      signedSignature === undefined ||
      !bytesEqual(signedSignature, existingSignature)
    ) {
      throw new Error("Local wallet changed an arbiter signature");
    }
  }
  assertIsTransactionWithinSizeLimit(signed);

  const selectedRpc = rpc ?? createSolanaRpc(getClusterUrl(cluster));
  const wire = getBase64EncodedWireTransaction(signed);
  const simulation = await selectedRpc
    .simulateTransaction(wire, { encoding: "base64", sigVerify: true })
    .send();
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join("\n") ?? "";
    throw new Error(
      logs
        ? `Embedded wallet simulation failed: ${logs.slice(-1000)}`
        : `Embedded wallet simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }

  const returnedSignature = await selectedRpc
    .sendTransaction(wire, { encoding: "base64", skipPreflight: false })
    .send();
  if (returnedSignature !== getSignatureFromTransaction(signed)) {
    throw new Error("RPC returned an unexpected transaction signature");
  }
  return new Uint8Array(getBase58Encoder().encode(returnedSignature));
}
