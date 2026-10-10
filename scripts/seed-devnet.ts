// Seeds devnet: config, models, a mock USDT mint, and a funded demo vault.
// Safe to re-run: every step skips work that already exists on-chain.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  address,
  createClient,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  type Address,
} from "@solana/kit";
import { solanaDevnetRpc } from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS, tokenProgram } from "@solana-program/token";
import {
  BLOCKROUTER_PROGRAM_ADDRESS,
  blockrouterProgram,
  fetchMaybeConfig,
  fetchMaybeModel,
  fetchMaybeVault,
  findConfigPda,
  findModelPda,
  findVaultPda,
} from "@blockrouter/client";

const DEPLOYMENT = process.env.DEPLOYMENT ?? "deployments/devnet.json";
const WALLET = process.env.WALLET ?? "keys/devnet-deployer.json";
const DEMO_WALLET = process.env.DEMO_WALLET ?? "keys/demo-user.json";
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");

const USDT_DECIMALS = 6;
const DEMO_MINT_AMOUNT = 100_000_000n; // 100 mock USDT
const DEMO_DEPOSIT_AMOUNT = 25_000_000n; // 25 mock USDT
const DEMO_MIN_LAMPORTS = 20_000_000n;
const DEMO_TOP_UP_LAMPORTS = 50_000_000n;

type Deployment = {
  cluster: string;
  programId: string;
  usdcMint: string;
  mockUsdtMint: string | null;
  relayer: string | null;
  config: { feeBps: number; disputeWindowSecs: number; priceTimelockSecs: number };
  models: { id: number; alias: string; promptRate: number; completionRate: number }[];
};

function requireFile(path: string, hint: string) {
  if (!existsSync(path)) {
    throw new Error(`${path} not found. ${hint}`);
  }
}

function client(walletPath: string) {
  return createClient()
    .use(signerFromFile(walletPath))
    .use(solanaDevnetRpc({ rpcUrl: RPC_URL }))
    .use(tokenProgram())
    .use(blockrouterProgram());
}

async function main() {
  requireFile(WALLET, "Set WALLET to the program upgrade authority keypair.");
  requireFile(DEMO_WALLET, `Create one with: solana-keygen new -o ${DEMO_WALLET}`);

  if (!existsSync(DEPLOYMENT)) {
    // Local deployments start from the devnet template; mints are created fresh.
    const template: Deployment = JSON.parse(await readFile("deployments/devnet.json", "utf8"));
    await writeFile(DEPLOYMENT, `${JSON.stringify({ ...template, cluster: "localnet", mockUsdtMint: null }, null, 2)}\n`);
  }
  const deployment: Deployment = JSON.parse(await readFile(DEPLOYMENT, "utf8"));
  if (deployment.programId !== BLOCKROUTER_PROGRAM_ADDRESS) {
    throw new Error(
      `${DEPLOYMENT} programId ${deployment.programId} != client ${BLOCKROUTER_PROGRAM_ADDRESS}`,
    );
  }

  const admin = await client(WALLET);
  const demo = await client(DEMO_WALLET);
  const rpc = admin.rpc;
  console.log(`admin: ${admin.payer.address}`);
  console.log(`demo:  ${demo.payer.address}`);

  const program = await rpc.getAccountInfo(BLOCKROUTER_PROGRAM_ADDRESS, { encoding: "base64" }).send();
  if (!program.value?.executable) {
    throw new Error("program is not deployed on devnet. Run scripts/deploy-devnet.sh first.");
  }

  // 1. Config
  const [config] = await findConfigPda();
  if ((await fetchMaybeConfig(rpc, config)).exists) {
    console.log(`config:   exists ${config}`);
  } else {
    const [programData] = await getProgramDerivedAddress({
      programAddress: UPGRADEABLE_LOADER,
      seeds: [getAddressEncoder().encode(BLOCKROUTER_PROGRAM_ADDRESS)],
    });
    await admin.blockrouter.instructions
      .initializeConfig({
        authority: admin.payer,
        programData,
        treasury: address(process.env.TREASURY ?? admin.payer.address),
        provider: address(process.env.PROVIDER ?? admin.payer.address),
        feeBps: deployment.config.feeBps,
        disputeWindowSecs: deployment.config.disputeWindowSecs,
        priceTimelockSecs: deployment.config.priceTimelockSecs,
      })
      .sendTransaction();
    console.log(`config:   created ${config}`);
  }

  // 2. Models
  for (const model of deployment.models) {
    const [key] = await findModelPda({ modelId: model.id });
    const existing = await fetchMaybeModel(rpc, key);
    if (existing.exists) {
      const { promptRate, completionRate } = existing.data;
      const drift =
        promptRate !== BigInt(model.promptRate) || completionRate !== BigInt(model.completionRate);
      console.log(`model ${model.id}:  exists ${model.alias}${drift ? " (rates differ, not updated)" : ""}`);
      continue;
    }
    await admin.blockrouter.instructions
      .registerModel({
        authority: admin.payer,
        modelId: model.id,
        promptRate: BigInt(model.promptRate),
        completionRate: BigInt(model.completionRate),
      })
      .sendTransaction();
    console.log(`model ${model.id}:  registered ${model.alias}`);
  }

  // 3. Mock USDT mint, controlled by the admin wallet
  let mockUsdt: Address;
  if (deployment.mockUsdtMint) {
    mockUsdt = address(deployment.mockUsdtMint);
    console.log(`usdt:     exists ${mockUsdt}`);
  } else {
    const newMint = await generateKeyPairSigner();
    await admin.token.instructions
      .createMint({ newMint, decimals: USDT_DECIMALS, mintAuthority: admin.payer.address })
      .sendTransaction();
    mockUsdt = newMint.address;
    deployment.mockUsdtMint = mockUsdt;
    await writeFile(DEPLOYMENT, `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`usdt:     created ${mockUsdt} (saved to ${DEPLOYMENT})`);
  }

  // 4. Demo vault funded with mock USDT
  const demoBalance = (await rpc.getBalance(demo.payer.address).send()).value;
  if (demoBalance < DEMO_MIN_LAMPORTS) {
    await admin.sendTransaction([
      getTransferSolInstruction({
        source: admin.payer,
        destination: demo.payer.address,
        amount: lamports(DEMO_TOP_UP_LAMPORTS),
      }),
    ]);
    console.log(`demo:     topped up ${DEMO_TOP_UP_LAMPORTS} lamports`);
  }

  const [vault] = await findVaultPda({ user: demo.payer.address, mint: mockUsdt });
  const existingVault = await fetchMaybeVault(rpc, vault);
  if (existingVault.exists && existingVault.data.balance > 0n) {
    console.log(`vault:    exists ${vault} balance ${existingVault.data.balance}`);
    return;
  }

  const [demoAta] = await findAssociatedTokenPda({
    owner: demo.payer.address,
    mint: mockUsdt,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await admin.token.instructions
    .mintToATA({
      owner: demo.payer.address,
      mint: mockUsdt,
      mintAuthority: admin.payer,
      amount: DEMO_MINT_AMOUNT,
      decimals: USDT_DECIMALS,
    })
    .sendTransaction();
  console.log(`demo:     minted ${DEMO_MINT_AMOUNT} mock USDT to ${demoAta}`);

  if (!existingVault.exists) {
    await demo.blockrouter.instructions
      .initializeVault({ user: demo.payer, mint: mockUsdt })
      .sendTransaction();
  }
  await demo.blockrouter.instructions
    .deposit({
      user: demo.payer,
      userAta: demoAta,
      vault,
      mint: mockUsdt,
      amount: DEMO_DEPOSIT_AMOUNT,
    })
    .sendTransaction();
  console.log(`vault:    ${vault} funded with ${DEMO_DEPOSIT_AMOUNT}`);
}

main().catch((error) => {
  let current: unknown = error;
  while (current instanceof Error) {
    console.error(current.message);
    const logs = (current as { context?: { logs?: string[] } }).context?.logs;
    if (logs) console.error(logs.join("\n"));
    current = current.cause;
  }
  process.exit(1);
});
