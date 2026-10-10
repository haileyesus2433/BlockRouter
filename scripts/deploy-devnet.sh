#!/usr/bin/env bash
# Deploys or upgrades the BlockRouter program on devnet, then publishes the IDL.
#
#   ./scripts/deploy-devnet.sh                  # uses keys/devnet-deployer.json
#   WALLET=path/to/key.json ./scripts/deploy-devnet.sh
#
# WALLET pays and becomes the upgrade authority, which is also the only key that
# can run initialize_config. PROGRAM_KEYPAIR is only needed for the first deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

URL="${URL:-https://api.devnet.solana.com}"
WALLET="${WALLET:-keys/devnet-deployer.json}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-target/deploy/blockrouter-keypair.json}"
SO="target/deploy/blockrouter.so"
IDL="target/idl/blockrouter.json"
ANCHOR_VERSION="1.2.0"
SBPF_ARCH="${SBPF_ARCH:-v2}"

fail() { echo "error: $*" >&2; exit 1; }

command -v solana >/dev/null || fail "solana CLI not found"
command -v anchor >/dev/null || fail "anchor CLI not found"
anchor --version | grep -q "$ANCHOR_VERSION" || fail "expected anchor $ANCHOR_VERSION, got $(anchor --version)"
[ -f "$WALLET" ] || fail "wallet $WALLET not found (set WALLET=...)"

declared_id="$(grep -oP 'declare_id!\("\K[^"]+' programs/blockrouter/src/lib.rs)"
anchor_toml_id="$(awk '/^\[programs.devnet\]/{f=1;next} /^\[/{f=0} f && /^blockrouter/{gsub(/[" ]/,"",$3); print $3}' Anchor.toml)"
[ "$declared_id" = "$anchor_toml_id" ] \
  || fail "declare_id ($declared_id) and Anchor.toml [programs.devnet] ($anchor_toml_id) differ"

if [ -f "$PROGRAM_KEYPAIR" ]; then
  keypair_id="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
  [ "$keypair_id" = "$declared_id" ] \
    || fail "$PROGRAM_KEYPAIR is $keypair_id but the program declares $declared_id"
  if git ls-files --error-unmatch "$PROGRAM_KEYPAIR" >/dev/null 2>&1; then
    fail "$PROGRAM_KEYPAIR is tracked by git; remove it from the index and rotate it"
  fi
fi

authority="$(solana-keygen pubkey "$WALLET")"
echo "program:   $declared_id"
echo "authority: $authority"
echo "cluster:   $URL"

# Devnet supports SBPF v1 and v2 but not v3, which is anchor build's default.
anchor build --arch "$SBPF_ARCH"
[ -f "$SO" ] || fail "$SO missing after build"

if solana program show "$declared_id" --url "$URL" >/dev/null 2>&1; then
  mode="upgrade"
  program_arg="$declared_id"
  current_authority="$(solana program show "$declared_id" --url "$URL" | awk '/^Authority:/{print $2}')"
  [ "$current_authority" = "$authority" ] \
    || fail "upgrade authority is $current_authority, not $authority"
else
  mode="deploy"
  [ -f "$PROGRAM_KEYPAIR" ] || fail "first deploy needs the program keypair at $PROGRAM_KEYPAIR"
  program_arg="$PROGRAM_KEYPAIR"
fi

so_bytes="$(stat -c %s "$SO")"
needed_lamports="$(solana rent "$so_bytes" --lamports | awk '/lamports/{print $(NF-1)}')"
# Program data plus a temporary buffer of the same size, refunded after the deploy.
needed_lamports=$(( needed_lamports * 2 ))
balance_lamports="$(solana balance "$authority" --url "$URL" --lamports | awk '{print $1}')"
echo "balance:   $balance_lamports lamports, need about $needed_lamports for $mode"
[ "$balance_lamports" -ge "$needed_lamports" ] \
  || fail "not enough SOL. Fund $authority on devnet (https://faucet.solana.com)"

solana program deploy "$SO" \
  --url "$URL" \
  --keypair "$WALLET" \
  --upgrade-authority "$WALLET" \
  --program-id "$program_arg" \
  --max-sign-attempts 20 \
  --use-rpc

if anchor idl fetch "$declared_id" --provider.cluster devnet >/dev/null 2>&1; then
  anchor idl upgrade "$declared_id" --filepath "$IDL" \
    --provider.cluster devnet --provider.wallet "$WALLET"
else
  anchor idl init "$declared_id" --filepath "$IDL" \
    --provider.cluster devnet --provider.wallet "$WALLET"
fi

echo
echo "deployed ($mode): https://explorer.solana.com/address/$declared_id?cluster=devnet"
