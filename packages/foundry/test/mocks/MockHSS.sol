// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice Emulates the HIP-1215 Hedera Schedule Service. Schedules are recorded rather than executed; tests fire
 *         them the way the network would: at the scheduled second, sent by the payer of the creating transaction.
 * @dev Etched at 0x16b in tests.
 */
contract MockHSS {
    int64 internal constant SUCCESS = 22;
    int64 internal constant INVALID_SCHEDULE_ID = 201;

    struct Schedule {
        address creator;
        address to;
        uint256 executeAt;
        uint256 gasLimit;
        bytes callData;
        bool executed;
        bool deleted;
    }

    uint256 public count;
    mapping(address => Schedule) internal _schedules;
    mapping(uint256 second => bool) public full;
    int64 public forcedResponse;

    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64, bytes memory callData)
        external
        returns (int64, address schedule)
    {
        if (forcedResponse != 0) return (forcedResponse, address(0));
        schedule = address(uint160(0x5c4ed00000 + ++count));
        _schedules[schedule] = Schedule(msg.sender, to, expirySecond, gasLimit, callData, false, false);
        return (SUCCESS, schedule);
    }

    function hasScheduleCapacity(uint256 expirySecond, uint256) external view returns (bool) {
        return !full[expirySecond];
    }

    function deleteSchedule(address schedule) external returns (int64) {
        Schedule storage s = _schedules[schedule];
        if (s.creator != msg.sender || s.executed || s.deleted) return INVALID_SCHEDULE_ID;
        s.deleted = true;
        return SUCCESS;
    }

    // --- test helpers ---

    /// @dev Makes every following scheduleCall fail with `code`; 0 restores normal behaviour.
    function forceResponse(int64 code) external {
        forcedResponse = code;
    }

    function setFull(uint256 second, bool isFull) external {
        full[second] = isFull;
    }

    function get(address schedule) external view returns (Schedule memory) {
        return _schedules[schedule];
    }

    /// @dev Tests call this right before replaying the schedule's call (see EarmarkTest._fire).
    function markExecuted(address schedule) external {
        Schedule storage s = _schedules[schedule];
        require(s.creator != address(0) && !s.executed && !s.deleted, "MockHSS: not pending");
        require(block.timestamp >= s.executeAt, "MockHSS: too early");
        s.executed = true;
    }
}
