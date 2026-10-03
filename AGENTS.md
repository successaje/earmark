# Agent instructions

Briefing for coding agents (Claude Code, Cursor, Codex) working in an Earmark app. Claude Code loads it through
`CLAUDE.md`. Read `README.md` for the product; this file is about changing the code safely.

## What this app is

Earmark is purpose-bound money on Hedera. One ownerless contract, `packages/foundry/contracts/Earmark.sol`, hosts
programs. Each program escrows an HTS stablecoin, creates an HTS voucher token whose KYC/wipe/pause keys are the
contract, and schedules its own settlement through the Hedera Schedule Service (HIP-1215). Charters and itemised
receipts are wallet-signed JSON anchored on an HCS topic; their keccak256 hashes are recorded on-chain.

Three properties are the point of the template. Keep them true in every change:

1. **Supply equals escrow.** Voucher total supply == `escrowOf(id)` while a program is open. Vouchers are wiped
   before backing leaves; the voucher has no supply key; backing tokens with custom fees are rejected.
   `test/EarmarkInvariant.t.sol` guards this.
2. **The network enforces the purpose.** Only accounts Earmark granted KYC can hold vouchers. Do not add code paths
   that move vouchers to accounts without KYC, and do not add a supply or admin key.
3. **Settlement cannot be blocked.** `settle` must never revert because of something a merchant or funder controls.
   Rejected payouts go to `owed`, rejected HBAR refunds to `hbarOwed`, a failed wipe skips the merchant, KYC
   revocation is best-effort, HBAR is sent without copying return data, and anyone may call `settle` after expiry.

## Extension seams

New features should plug into one of the four policies (README, "The four policies") rather than spreading through
the contract: **eligibility** (`allocate`/`claim`), **spending** (`approveMerchant`/`removeMerchant`, HTS KYC),
**evidence** (`utils/earmark/messages.ts`, `api/hcs`), **settlement** (`settle`/`_close`). Merchant categories are
labels; if you add category budgets, enforcement must live in a contract entry point, because a plain HTS transfer
cannot say which budget it spends from.

## SaucerSwap

`createProgramWithHbar` swaps through SaucerSwap's V1 router (constructor arguments, set per chain in
`script/Deploy.s.sol`). Keep the escrow equal to the *measured* balance increase, keep the funder's `minOut` floor,
and associate the contract with the output token before swapping. The frontend quotes with `getAmountsOut`
(`saucerSwapRouterAbi`) and needs `GAS.createProgramWithHbar`. `test/mocks/MockSaucerRouter.sol` can simulate a
router that delivers less than it reports.

## Commands

```bash
yarn start                                   # Next.js dev server on :3000
yarn test                                    # forge tests (HTS/HSS emulated, no network)
yarn lint                                    # forge fmt --check + ESLint
yarn next:check-types && yarn next:build
yarn foundry:deploy --network hedera_testnet # then:
yarn earmark:setup                           # dUSD token + HCS topic (needs operator env)
yarn earmark:demo                            # full lifecycle on testnet, prints HashScan links
```

Run `yarn test`, `yarn lint` and `yarn next:check-types` before finishing any change. Run `yarn earmark:demo` after
changing contract behaviour that touches HTS or HSS; the mocks cannot prove network behaviour.

Earmark cannot run on a plain Anvil chain: it needs the system contracts at `0x167` (HTS) and `0x16b` (HSS). Deploy to
Hedera testnet.

## Where things live

| Area | Path |
| --- | --- |
| Contract | `packages/foundry/contracts/Earmark.sol` |
| System-contract interfaces | `packages/foundry/contracts/hedera/` |
| Tests and emulators | `packages/foundry/test/Earmark.t.sol`, `test/EarmarkInvariant.t.sol`, `test/mocks/` |
| Deploy script (bytecode only) | `packages/foundry/script/Deploy.s.sol` |
| Generated ABIs/addresses | `packages/nextjs/contracts/deployedContracts.ts` (do not edit; regenerated on deploy) |
| HCS document formats | `packages/nextjs/utils/earmark/messages.ts` |
| Mirror-node reads | `packages/nextjs/utils/earmark/mirror.ts` |
| HCS anchoring API (+ dedupe/rate limit) | `packages/nextjs/app/api/hcs/route.ts`, `services/earmark/submissionGuard.ts` |
| Server/CLI Hedera SDK client | `packages/nextjs/services/earmark/hcs.ts` |
| React hooks | `packages/nextjs/hooks/earmark/index.ts` |
| Pages | `packages/nextjs/app/page.tsx`, `app/programs/new`, `app/programs/[id]` |
| CLI scripts | `packages/nextjs/scripts/` |

## Rules that are easy to get wrong on Hedera

- **Gas.** HTS and HSS work is billed as gas that EVM estimation does not see. Every write that touches a token or
  schedule passes an explicit `gas` from `GAS` in `utils/earmark/abis.ts`. Add an entry when you add such a write; use
  `useHederaWrite` in the frontend, which requires it.
- **Response codes.** System-contract calls return an `int64` code; `22` is success. In Solidity, check every code
  (`_check`) except where settlement must not revert. Add new codes users may hit to `utils/earmark/responseCodes.ts`.
- **Time.** `block.timestamp` can trail consensus time by up to ~2 s. Anything scheduled to run "at" a time must be
  scheduled `SETTLEMENT_DELAY` after it.
- **Scheduled calls.** `msg.sender` inside a scheduled execution is the payer of the transaction that created the
  schedule, not the contract. Never gate scheduled entry points on `msg.sender`. Schedules expire after 62 days.
- **Association.** Accounts must associate with a token (HIP-719 `associate()` on the token address, called by the
  account) before KYC can be granted or tokens received. Contracts cannot associate other accounts.
- **Addresses.** HTS tokens, schedules and HCS-adjacent entities use long-zero EVM addresses. Convert with
  `entityIdFromAddress` / `addressFromEntityId` in `utils/earmark/network.ts`; HashScan and the mirror node want
  `0.0.x` ids.
- **Mirror node lag.** Mirror data trails consensus by a few seconds. Poll; do not assume a just-mined change is
  visible.
- **HCS size.** Keep each envelope ≤ 1,024 bytes (`MAX_HCS_MESSAGE_BYTES`). Extend schemas with that budget in mind.
- **Secrets.** `HEDERA_OPERATOR_KEY` is server-only. Never import `services/earmark/hcs.ts` from a client component,
  and never add a `NEXT_PUBLIC_` variable holding a key.

## Changing the contract

1. Edit `Earmark.sol`; keep it under the 24 KB limit (`forge build --sizes`; the optimizer is on).
2. Add or update tests in `Earmark.t.sol`; if you add a state-changing entry point, add it to `EarmarkHandler` so the
   invariants exercise it. Extend `MockHTS`/`MockHSS` only to mirror real network behaviour, using
   real response codes — a mock that is more permissive than the network hides bugs.
3. `yarn test && yarn foundry:lint`.
4. Redeploy (`yarn foundry:deploy --network hedera_testnet`), which regenerates `deployedContracts.ts`, then
   `yarn earmark:setup` and `yarn earmark:demo`.
5. If you change events, update `EVENT_LABELS` in `app/programs/[id]/_components/Ledger.tsx`.

## Changing HCS documents

Bump `version` in the schema rather than changing the meaning of an existing field: receipts already on the topic must
keep verifying. Hashes are over `canonicalize(body)`; signatures are EIP-191 over that hash (`{ message: { raw } }`).
The API route and the browser must apply the same checks.

## Frontend conventions

- Next.js App Router; add `"use client"` to components that use hooks. Pages under `app/`, page-only components in
  that route's `_components/`.
- Contract reads: `useScaffoldReadContract` / wagmi `useReadContracts`. Writes: `useHederaWrite` (explicit gas,
  scaffold transactor notifications, refreshes queries afterwards).
- Native Hedera state (association, KYC, schedules, topic messages, logs): the hooks in `hooks/earmark`, backed by
  `utils/earmark/mirror.ts`.
- Styling: DaisyUI components and Tailwind utilities; shared pieces in `components/earmark/primitives.tsx`.
- Imports use the `~~/` alias. Prefer `type` over `interface`. Comments explain why, not what.

## Style

| Style | Use |
| --- | --- |
| `UpperCamelCase` | types, components, contracts |
| `lowerCamelCase` | variables, functions |
| `CONSTANT_CASE` | constants |
| `snake_case` | Foundry test names after `test_`, e.g. `test_claim_requiresAssociation` |
