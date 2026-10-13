// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IBrokerageForTest {
    function withdrawOffer(uint256 offerId) external;
    function withdrawProceeds() external;
}

/**
 * @notice Test-only counterparty that misbehaves on demand. Never deployed by the deploy script.
 *   mode 0: behaves
 *   mode 1: rejects the native coin
 *   mode 2: re-enters the brokerage (withdrawOffer(target)) when it receives the coin
 *   mode 3: re-enters the brokerage (withdrawOffer(target)) when it receives a deed
 */
contract HostileParty is IERC721Receiver {
    IBrokerageForTest public immutable desk;
    uint8 public mode;
    uint256 public target;

    constructor(address brokerage) {
        desk = IBrokerageForTest(brokerage);
    }

    function setMode(uint8 m, uint256 t) external {
        mode = m;
        target = t;
    }

    /// @notice Forwards an arbitrary call so tests can act as this contract.
    function exec(address to, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        if (mode == 1) revert("HostileParty: no coin");
        if (mode == 2) desk.withdrawOffer(target);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (mode == 3) desk.withdrawOffer(target);
        return IERC721Receiver.onERC721Received.selector;
    }
}
