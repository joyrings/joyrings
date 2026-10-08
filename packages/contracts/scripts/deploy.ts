import hre, { ethers, network } from "hardhat";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MATERIALS, GEMS, RING_MODELS } from "../../../apps/web/src/lib/catalog";

/**
 * Deploys JoyRings and seeds the catalog from the website's model list, so the
 * on-chain model ids always match apps/web/src/lib/catalog.ts.
 *
 * Artwork comes from artwork.json (written by `pnpm pin`), so every model is
 * seeded with its real CID and the very first mint already has a picture.
 * Without it the models get `ipfs://TODO/...` placeholders, fixed later with
 * setModelMedia. That is fine on a test chain; on mainnet anything minted in
 * between would show a broken image in every wallet, so it is refused there.
 *
 * On a public network the result is written to deployments/<network>.json,
 * which is committed, and both contracts are verified when ETHERSCAN_API_KEY
 * is set.
 *
 * Resumable: with JOYRINGS_ADDRESS set, nothing is deployed. The script
 * attaches to that contract and seeds only the models it does not have yet,
 * so a run cut off halfway through the catalog is finished, not repeated.
 */

function readPinnedArtwork(): Map<string, { image?: string; animation?: string }> {
  const bySlug = new Map<string, { image?: string; animation?: string }>();
  const manifestPath = path.resolve(__dirname, "../../../artwork.json");
  if (!existsSync(manifestPath)) return bySlug;
  // Strip a UTF-8 BOM: Windows editors add one and JSON.parse rejects it.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^﻿/, "")) as {
    files: Record<string, { slug: string; kind: "image" | "animation"; uri: string }>;
  };
  for (const entry of Object.values(manifest.files)) {
    bySlug.set(entry.slug, { ...bySlug.get(entry.slug), [entry.kind]: entry.uri });
  }
  return bySlug;
}

const USDC_BY_NETWORK: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // Circle's testnet USDC. Anyone can get some at https://faucet.circle.com.
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const LOCAL = network.name === "hardhat" || network.name === "localhost";

/**
 * Public RPCs are load-balanced, and the node answering a read is not always
 * the one that saw the last block: a value written a second ago can read back
 * as missing. Retried for a while before the answer counts.
 */
async function settled<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T | undefined> {
  let last: T | undefined;
  for (let attempt = 0; attempt < (LOCAL ? 1 : 10); attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    last = await read().catch(() => undefined);
    if (last !== undefined && ok(last)) return last;
  }
  return last;
}

function gitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

async function verify(address: string, constructorArguments: unknown[]) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already verified/i.test(message)) {
      console.log(`  ${address} is already verified.`);
    } else {
      console.log(`  Verification of ${address} failed, retry with \`pnpm hardhat verify\`:\n  ${message}`);
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer: set DEPLOYER_PRIVATE_KEY in packages/contracts/.env.");
  console.log("Network:", network.name);
  console.log("Deploying with:", deployer.address);

  // Checked before anything is sent, so a refusal costs no gas.
  const pinned = readPinnedArtwork();
  const unpinned = RING_MODELS.filter((m) => !pinned.get(m.slug)?.image).map((m) => m.slug);
  if (network.name === "base" && unpinned.length > 0 && process.env.ALLOW_PLACEHOLDER_ART !== "1") {
    throw new Error(
      `${unpinned.length} model(s) have no pinned artwork in artwork.json:\n  ${unpinned.join(", ")}\n` +
        "Run `pnpm pin` first. Anything minted before the artwork is set would show a broken image.\n" +
        "Set ALLOW_PLACEHOLDER_ART=1 to deploy anyway."
    );
  }

  const existing = process.env.JOYRINGS_ADDRESS;
  let usdcAddress = process.env.USDC_ADDRESS || USDC_BY_NETWORK[network.name];
  if (!usdcAddress && !existing) {
    if (!LOCAL) throw new Error(`No USDC address known for ${network.name}: set USDC_ADDRESS.`);
    // Local chains get a mock so the whole flow is testable end to end.
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mock = await MockUSDC.deploy();
    await mock.waitForDeployment();
    usdcAddress = await mock.getAddress();
    await (await mock.mint(deployer.address, 1_000_000_000n)).wait(); // 1000 USDC
    console.log("MockUSDC deployed at:", usdcAddress);
  }
  let metadataAddress: string;
  let deployBlock: number | undefined;
  let owner: string;
  const JoyRings = await ethers.getContractFactory("JoyRings");
  let ring: Awaited<ReturnType<typeof JoyRings.deploy>>;
  if (existing) {
    ring = JoyRings.attach(existing) as typeof ring;
    metadataAddress = await ring.metadata();
    usdcAddress = await ring.usdc();
    owner = await ring.owner();
    deployBlock = process.env.DEPLOY_BLOCK ? Number(process.env.DEPLOY_BLOCK) : undefined;
    console.log("Resuming JoyRings at:", existing);
    console.log("JoyRingsMetadata at:", metadataAddress);
  } else {
    // tokenURI is assembled by a separate, ownerless contract: together they
    // would exceed the 24 KB contract size limit. JoyRings takes its address
    // once, here, and can never be repointed.
    const Metadata = await ethers.getContractFactory("JoyRingsMetadata");
    const metadata = await Metadata.deploy();
    await metadata.waitForDeployment();
    metadataAddress = await metadata.getAddress();
    console.log("JoyRingsMetadata deployed at:", metadataAddress);

    ring = await JoyRings.deploy(deployer.address, usdcAddress!, metadataAddress);
    await ring.waitForDeployment();
    owner = deployer.address;
    console.log("JoyRings deployed at:", await ring.getAddress());

    // Nothing in the app needs it, but an indexer or a Dune query will start
    // here, and finding it afterwards means hunting through an explorer.
    deployBlock = (await ring.deploymentTransaction()?.wait())?.blockNumber;
    console.log("Deployed in block:", deployBlock);
  }
  const ringAddress = await ring.getAddress();
  console.log("USDC:", usdcAddress);

  // Collection-level metadata. CONTRACT_URI is what marketplaces read for the
  // collection page; SITE_URL gives every token a link back to its own page.
  const contractUri = process.env.CONTRACT_URI ?? "";
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
  if (contractUri) {
    await (await ring.setContractURI(contractUri)).wait();
    console.log("contractURI:", contractUri);
  } else {
    console.log("CONTRACT_URI not set: the marketplace collection page will be unnamed.");
  }
  if (siteUrl) {
    await (await ring.setExternalBaseURI(`${siteUrl}/r/`)).wait();
    console.log("external_url base:", `${siteUrl}/r/`);
  } else {
    // Not a problem, and not permanent: tokenURI simply omits external_url
    // until a base is set, rather than emitting a link to nowhere.
    console.log(
      "SITE_URL not set, so tokens carry no link back to the shop yet.\n" +
        "  Once the domain exists: ring.setExternalBaseURI('https://yourdomain/r/').\n" +
        "  Existing tokens pick it up at once, because tokenURI is assembled on read."
    );
  }

  // The contract's words and the catalog's ids must agree before any model
  // points at them: a model saved as material 11 is "Wood" forever.
  for (const spec of Object.values(MATERIALS)) {
    const word = await settled(() => ring.materials(spec.id), (w) => w === spec.label);
    if (word !== spec.label) {
      throw new Error(
        `Material ${spec.id} is "${word ?? "missing"}" on-chain but "${spec.label}" in catalog.ts. ` +
          "Fix the constructor list or the catalog ids; after deployment, append with addMaterial()."
      );
    }
  }
  for (const spec of Object.values(GEMS)) {
    const word = await settled(() => ring.gems(spec.id), (w) => w === spec.label);
    if (word !== spec.label) {
      throw new Error(`Gem ${spec.id} is "${word ?? "missing"}" on-chain but "${spec.label}" in catalog.ts.`);
    }
  }

  const sorted = [...RING_MODELS].sort((a, b) => a.id - b.id);
  for (const [index, model] of sorted.entries()) {
    if (model.id !== index) {
      throw new Error(
        `Catalog ids must be contiguous from 0. Expected ${index}, found ${model.id} (${model.slug}).`
      );
    }
    // Prices are set by hand, one per model, and a wrong one is permanent for
    // everyone who mints before it is noticed. The floor is the cheap half of
    // the check: it catches the whole class of "this plastic ring costs more
    // than platinum" before the transaction is sent, rather than after.
    const floor = MATERIALS[model.material].floorUsdc + GEMS[model.gem].premiumUsdc;
    if (model.priceUsdc < floor) {
      throw new Error(
        `${model.slug} is priced at ${model.priceUsdc} USDC, below the ${floor} USDC floor for ` +
          `${MATERIALS[model.material].label}${model.gem === "none" ? "" : ` + ${GEMS[model.gem].label}`}. ` +
          `Fix the price in catalog.ts, or lower the floor if the material is genuinely worth less.`
      );
    }
  }

  // Only what the contract does not have yet: a fresh deployment seeds all of
  // it, a resumed one picks up where the last run stopped.
  // A lagging node can only under-count, and an under-count here would add a
  // model twice, so the highest of a few reads wins.
  let already = 0;
  for (let read = 0; read < (LOCAL || !existing ? 1 : 4); read++) {
    if (read > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    already = Math.max(already, Number(await ring.nextModelId()));
  }
  if (already > 0) console.log(`${already} model(s) already on-chain, seeding from #${already}.`);
  for (const model of sorted.slice(already)) {
    const media = pinned.get(model.slug);
    const tx = await ring.addModel(
      model.name,
      MATERIALS[model.material].id,
      GEMS[model.gem].id,
      BigInt(model.priceUsdc) * 1_000_000n,
      model.maxSupply,
      media?.image ?? `ipfs://TODO/${model.slug}`,
      media?.animation ?? ""
    );
    await tx.wait();
    console.log(`  #${model.id} ${model.name}: ${model.priceUsdc} USDC`);
  }
  const size = await settled(() => ring.nextModelId(), (n) => n === BigInt(sorted.length));
  console.log("Catalog size:", size?.toString());

  if (!LOCAL) {
    const outDir = path.resolve(__dirname, "../deployments");
    mkdirSync(outDir, { recursive: true });
    const record = {
      network: network.name,
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      JoyRings: ringAddress,
      JoyRingsMetadata: metadataAddress,
      usdc: usdcAddress,
      owner,
      deployBlock,
      deployedAt: new Date().toISOString(),
      commit: gitCommit(),
    };
    const outPath = path.join(outDir, `${network.name}.json`);
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log("Written:", path.relative(process.cwd(), outPath));

    if (process.env.ETHERSCAN_API_KEY) {
      console.log("Verifying source on the explorer...");
      await verify(metadataAddress, []);
      await verify(ringAddress, [owner, usdcAddress, metadataAddress]);
    } else {
      console.log(
        "ETHERSCAN_API_KEY not set, so the source is not verified. Later:\n" +
          `  pnpm hardhat verify --network ${network.name} ${metadataAddress}\n` +
          `  pnpm hardhat verify --network ${network.name} ${ringAddress} ` +
          `${owner} ${usdcAddress} ${metadataAddress}`
      );
    }
  }

  if (unpinned.length > 0) {
    console.log(
      `\n${unpinned.length} model(s) were seeded with placeholder artwork. ` +
        "Pin the artwork, then point each model at it with setModelMedia."
    );
  }
  console.log(
    `\nSales are paid to the treasury, currently ${await ring.treasury()} (the deployer).\n` +
      "  Point it at a multisig with ring.setTreasury(address).\n" +
      "  Ownership moves in two steps: transferOwnership(multisig), then acceptOwnership() from it."
  );
  const withoutArtwork = sorted.filter((m) => !m.images?.[0]).map((m) => m.slug);
  if (withoutArtwork.length > 0) {
    console.log(
      `\nWARNING: ${withoutArtwork.length} model(s) have no artwork in the catalog and were ` +
        `seeded with a URI that will never resolve. The website falls back to the generated ` +
        `SVG, but a minted token points at nothing:\n  ${withoutArtwork.join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
