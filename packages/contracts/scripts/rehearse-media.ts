/**
 * Rehearses the artwork sync against a throwaway local deployment.
 *
 *   pnpm --filter contracts rehearse-media
 *
 * Seeds a fresh contract from the catalog, then runs syncMedia against the real
 * artwork.json three times: dry run, real run, and again to prove it is
 * idempotent. Use it to check a manifest before spending gas on Base.
 */
import { ethers } from "hardhat";
import { MATERIALS, GEMS, RING_MODELS } from "../../../apps/web/src/lib/catalog";
import { syncMedia } from "./sync-media";

async function main() {
  const [deployer] = await ethers.getSigners();
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  const metadata = await (await ethers.getContractFactory("JoyRingsMetadata")).deploy();
  const JoyRings = await ethers.getContractFactory("JoyRings");
  const ring = await JoyRings.deploy(
    deployer.address,
    await usdc.getAddress(),
    await metadata.getAddress()
  );
  const address = await ring.getAddress();

  for (const model of [...RING_MODELS].sort((a, b) => a.id - b.id)) {
    await ring.addModel(
      model.name,
      MATERIALS[model.material].id,
      GEMS[model.gem].id,
      BigInt(model.priceUsdc) * 1_000_000n,
      model.maxSupply,
      `ipfs://TODO/${model.slug}.png`,
      ""
    );
  }
  console.log(`Seeded ${await ring.nextModelId()} models\n`);

  console.log("--- dry run ---");
  await syncMedia(address, true);

  console.log("\n--- real run ---");
  await syncMedia(address, false);

  console.log("\n--- second run, should be a no-op ---");
  await syncMedia(address, false);

  console.log("\nStored artwork:");
  for (const id of [0, 9, 1]) {
    const m = await ring.getModel(id);
    console.log(`  #${id} ${m.name}: ${m.imageURI}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
