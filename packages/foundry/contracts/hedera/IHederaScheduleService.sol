// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Hedera Schedule Service system contract (0x16b), HIP-1215 generalized scheduled calls.
/// @dev Lets a contract schedule a call to itself (or any contract) that the network executes at
///      `expirySecond`. The scheduling contract pays for the execution, so no off-chain keeper is needed.
interface IHederaScheduleService {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
