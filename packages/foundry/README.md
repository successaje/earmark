# Foundry package — Earmark contracts

| Contract | Purpose |
| --- | --- |
| `contracts/Earmark.sol` | Purpose-bound money: escrow, KYC-gated voucher, enrolment, redemption, self-scheduled settlement |
| `contracts/DemoDollar.sol` | Testnet-only HTS stablecoin with a faucet, so the template runs without USDC |
| `contracts/hedera/` | Minimal interfaces for the HTS (`0x167`) and HSS (`0x16b`) system contracts, plus response codes |

The root [README](../../README.md) explains the design; [AGENTS.md](../../AGENTS.md) lists the invariants to keep.

## Setup

Libraries are git submodules (forge-std and OpenZeppelin), pinned in `foundry.lock`. The scaffold CLI
installs them; in a plain clone run:

```bash
git submodule update --init --recursive
```

## Test

```bash
yarn test          # from the repo root: yarn foundry:test
```

Tests run on a plain local EVM. `test/mocks/MockHTS.sol` and `test/mocks/MockHSS.sol` are etched at the system
contract addresses and reproduce the behaviour Earmark depends on, returning the network's real response codes:

- KYC checked on sender and recipient, association required before KYC or receipt;
- key-gated KYC, wipe and pause; pause blocks every operation; the treasury cannot be wiped;
- `transferFrom` allowances; creation fees taken from `msg.value` with the excess refunded to the caller;
- schedules recorded with their target second and fired by the test exactly as the network would.

Network behaviour itself is verified by `yarn earmark:demo`, which runs a full program on testnet.

## Deploy

Earmark needs the Hedera system contracts, so deploy to testnet or mainnet — not to Anvil.

```bash
yarn foundry:account:import                                  # keystore for a funded ECDSA account
yarn foundry:deploy --network hedera_testnet --keystore <name>
yarn earmark:setup                                            # create dUSD and the HCS topic
```

`script/Deploy.s.sol` only deploys bytecode. Forge simulates scripts on a local EVM before broadcasting, and calls to
`0x167`/`0x16b` would fail there; token and topic creation happen in `earmark:setup` against the real network.
Deploying writes `deployments/<chainId>.json` and regenerates `packages/nextjs/contracts/deployedContracts.ts`.

Verify on Sourcify:

```bash
yarn foundry:verify:testnet <address> contracts/Earmark.sol:Earmark
```
