import { erc20Abi } from "viem";

/** SaucerSwap V1 router quote, used to preview HBAR funding. */
export const saucerSwapRouterAbi = [
  {
    type: "function",
    name: "getAmountsOut",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
  },
] as const;

/**
 * Every HTS token answers ERC-20 calls at its long-zero address (HIP-218), plus HIP-719's `associate()`, which an
 * account calls on the token itself to opt in to holding it.
 */
export const htsTokenAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "associate",
    inputs: [],
    outputs: [{ name: "responseCode", type: "int64" }],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Explicit gas limits for calls that touch the HTS and HSS system contracts. Association and token fees are charged
 * as gas, which a plain EVM estimate does not see, so estimated limits fail with INSUFFICIENT_GAS.
 */
export const GAS = {
  associate: 1_000_000n,
  transfer: 1_000_000n,
  approve: 1_000_000n,
  drip: 1_500_000n,
  createProgram: 4_000_000n,
  createProgramWithHbar: 6_000_000n,
  allocate: 500_000n,
  claim: 1_500_000n,
  approveMerchant: 1_000_000n,
  removeMerchant: 1_500_000n,
  redeem: 1_000_000n,
  withdrawOwed: 1_000_000n,
  extendExpiry: 1_500_000n,
  settle: 3_000_000n,
} as const;
