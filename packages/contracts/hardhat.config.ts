import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      // Both settings are about size, not speed. JoyRings has to fit the
      // 24,576-byte EIP-170 limit, which Base enforces exactly like Ethereum:
      // the IR pipeline and runs: 1 (optimise for deployment size) are what
      // get it there, with about 300 bytes to spare. The gas cost of runs: 1
      // is fractions of a cent on an L2. Turning either off makes the
      // contract undeployable; run `pnpm size` after any change.
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts,
    },
  },
  // One Etherscan API key covers every chain it indexes, Base and Base
  // Sepolia included (Etherscan API v2). Free at https://etherscan.io/apis.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
  sourcify: { enabled: false },
};

export default config;
