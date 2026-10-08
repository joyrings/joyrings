# Developing Joyrings

The technical side of the repository. What the project is, is in the [README](README.md).

This repository holds the Joyrings smart contracts: everything that decides what a ring
is, what it costs and what can never change. The website is a separate, closed codebase
that talks to these contracts like any other client would.

## Layout

```
packages/contracts/contracts      JoyRings.sol, JoyRingsMetadata.sol, test mocks
packages/contracts/test           the test suite
packages/contracts/scripts        deploy, size check, artwork sync
packages/contracts/deployments    where each network's contracts live
apps/web/src/lib/catalog.ts       every ring model, its material, gem, price and edition;
                                  the deploy script seeds the contract from it
```

## Commands

```bash
pnpm install
pnpm test:contracts                         # the full test suite
pnpm --filter contracts size                # bytecode size against the 24,576-byte limit
pnpm --filter contracts node                # a local chain, in one terminal
pnpm --filter contracts deploy:local        # deploy and seed the catalog on it, in another
```

Deploying to a public network needs `packages/contracts/.env`, see
`packages/contracts/.env.example`. The deploy script refuses any ring priced below the
floor of its material, writes the result to `deployments/<network>.json`, and verifies
both contracts on BaseScan when `ETHERSCAN_API_KEY` is set. If a run is cut off, set
`JOYRINGS_ADDRESS` to the deployed contract and run it again: it seeds only the models
that are missing.

## Deployed

| Network | JoyRings | Source |
|---|---|---|
| Base Sepolia | [`0xCF98Ee83d6704a6CC2fB8c59FfD126053070B51B`](https://sepolia.basescan.org/address/0xCF98Ee83d6704a6CC2fB8c59FfD126053070B51B#code) | verified |

The metadata renderer is
[`0x0Ebd217153D2ca159DAE202351F2C87FaC181B76`](https://sepolia.basescan.org/address/0x0Ebd217153D2ca159DAE202351F2C87FaC181B76#code);
both, with the deploy block, are in `packages/contracts/deployments/baseSepolia.json`.

## The contract in one paragraph

`JoyRings.sol` is a single ERC-721 for the whole shop. Ring designs are catalog entries,
not contracts: the owner calls `addModel` and the design is instantly mintable, so a 50th
ring is one transaction. `mint(modelId, size, inscription, referrer)` takes the price in
USDC and pays it **straight to the treasury**: the contract never holds revenue, so there
is no balance in it for anyone to drain. Size, inscription and date are stored per token,
and `tokenURI` is assembled on-chain by `JoyRingsMetadata.sol`, a stateless contract with
no owner whose address is fixed in the constructor. Proposals (`propose` / `accept` /
`decline` / `cancelProposal`, and `proposeByLink` / `acceptByLink` for someone with no
wallet yet) lock a ring until it is answered; every yes writes a new numbered `Union`,
the certificate, which is never rewritten. Witnesses, pairs and gifts complete it.

There is no proxy and no upgrade path, by design: what the contract promises is that
nothing written into a ring can be changed later, by anyone, including us.

## The size limit

Base enforces the 24,576-byte EIP-170 limit, and JoyRings sits about 300 bytes under it.
That is why the build uses `viaIR` with `runs: 1`, why `tokenURI` lives in a separate
renderer, and why lists are read with Multicall3 over single-item getters instead of
array views. Run `pnpm --filter contracts size` after any change to the contract.
