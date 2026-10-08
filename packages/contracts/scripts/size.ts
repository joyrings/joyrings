import { artifacts } from "hardhat";

/**
 * Deployed bytecode sizes against the EIP-170 limit. JoyRings lives close to
 * it, so this is the number to check after every change to the contract.
 */
const LIMIT = 24_576;

async function main() {
  for (const name of ["JoyRings", "JoyRingsMetadata"]) {
    const { deployedBytecode } = await artifacts.readArtifact(name);
    const bytes = (deployedBytecode.length - 2) / 2;
    const left = LIMIT - bytes;
    console.log(`${name.padEnd(18)} ${bytes.toLocaleString("en-US").padStart(6)} bytes, ${left.toLocaleString("en-US")} left`);
    if (left < 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
