#!/usr/bin/env bash
# Print a Piñata Session account from its session ID.
set -euo pipefail

if [[ $# -ne 1 || -z ${1:-} ]]; then
  echo "Usage: bun run anchor:account-session <session_id>" >&2
  exit 1
fi

session_id="$1"
if (( $(printf %s "$session_id" | wc -c) > 24 )); then
  echo "Session ID must be at most 24 UTF-8 bytes." >&2
  exit 1
fi

cd "$(dirname "$0")/../anchor"
idl_path="target/idl/pinata.json"
if [[ ! -f "$idl_path" ]]; then
  echo "Missing IDL: $idl_path. Run bun run anchor-build first." >&2
  exit 1
fi

program_id=$(jq -r '.address' "$idl_path")
session_pda=$(solana find-program-derived-address "$program_id" string:session "string:$session_id")
if ! output=$(NO_DNA=1 anchor account pinata.Session "$session_pda" --idl "$idl_path" 2>&1); then
  if [[ "$output" == *"AccountNotFound: pubkey=$session_pda"* && "$output" != *"AccountNotFound: pubkey=$session_pda:"* ]]; then
    echo "No Session account found for '$session_id' (PDA: $session_pda)." >&2
  else
    echo "$output" >&2
  fi
  exit 1
fi
echo "$output"
