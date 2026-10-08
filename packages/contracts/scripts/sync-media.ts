import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RING_MODELS } from "../../../apps/web/src/lib/catalog";

/**
 * Points on-chain models at their pinned artwork.
 *
 *   pnpm --filter contracts sync-media -- --network baseSepolia [--dry-run]
 *
 * Reads artwork.json (written by scripts/pin-artwork.mjs), compares each
 * model's media with what the contract already stores, and only sends a
 * transaction where something actually differs. Safe to re-run.
 *
 * Requires JOYRINGS_ADDRESS in the environment.
 */

interface ManifestEntry {
  slug: string;
  kind: "image" | "animation";
  uri: string;
}

const ROOT = path.resolve(__dirname, "../../..");

export async function syncMedia(address: string, dryRun: boolean) {
  const manifestPath = path.join(ROOT, "artwork.json");
  if (!existsSync(manifestPath)) {
    throw new Error("artwork.json not found. Run `node scripts/pin-artwork.mjs` first.");
  }
  // Strip a UTF-8 BOM: Windows editors add one and JSON.parse rejects it.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^﻿/, "")) as {
    files: Record<string, ManifestEntry>;
  };

  const ring = await ethers.getContractAt("JoyRings", address);
  const modelCount = Number(await ring.nextModelId());
  console.log(`Network: ${network.name}`);
  console.log(`JoyRings: ${address} (${modelCount} models on-chain)\n`);

  const bySlug = new Map<string, { image?: string; animation?: string }>();
  for (const entry of Object.values(manifest.files)) {
    const current = bySlug.get(entry.slug) ?? {};
    current[entry.kind] = entry.uri;
    bySlug.set(entry.slug, current);
  }

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const model of [...RING_MODELS].sort((a, b) => a.id - b.id)) {
    const pinned = bySlug.get(model.slug);
    if (!pinned?.image) {
      skipped += 1;
      continue;
    }
    if (model.id >= modelCount) {
      console.log(`  #${model.id} ${model.name}: not on-chain yet, run addModel first`);
      skipped += 1;
      continue;
    }

    const onChain = await ring.getModel(model.id);
    if (onChain.name !== model.name) {
      throw new Error(
        `Model #${model.id} is "${onChain.name}" on-chain but "${model.name}" in the catalog. ` +
          "Ids have drifted; fix that before syncing media."
      );
    }

    const nextImage = pinned.image;
    const nextAnimation = pinned.animation ?? "";
    const imageChanged = onChain.imageURI !== nextImage;
    const animationChanged = nextAnimation !== "" && onChain.animationURI !== nextAnimation;

    if (!imageChanged && !animationChanged) {
      unchanged += 1;
      continue;
    }

    console.log(`  #${model.id} ${model.name}`);
    if (imageChanged) console.log(`      image: ${onChain.imageURI || "(none)"} -> ${nextImage}`);
    if (animationChanged) console.log(`      animation: -> ${nextAnimation}`);

    if (!dryRun) {
      // Empty strings keep the stored value, so only changed fields are sent.
      const tx = await ring.setModelMedia(
        model.id,
        imageChanged ? nextImage : "",
        animationChanged ? nextAnimation : ""
      );
      await tx.wait();
    }
    updated += 1;
  }

  console.log(
    `\n${dryRun ? "Would update" : "Updated"} ${updated}, unchanged ${unchanged}, skipped ${skipped}.`
  );
  if (dryRun && updated > 0) console.log("Re-run without --dry-run to send the transactions.");
  return { updated, unchanged, skipped };
}

async function main() {
  const address = process.env.JOYRINGS_ADDRESS;
  if (!address) throw new Error("Set JOYRINGS_ADDRESS to the deployed contract.");
  await syncMedia(address, process.argv.includes("--dry-run"));
}

// Only run as a script, so the harness and tests can import syncMedia directly.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
