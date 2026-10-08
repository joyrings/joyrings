// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IJoyRingsAccept {
    function accept(uint256 tokenId, string calldata reply) external;
}

/// @dev A contract wallet, used to prove that accepting a proposal cannot
///      strand a ring somewhere that is unable to hold an ERC-721. With
///      `canReceive` false the receiver hook answers with the wrong selector,
///      which is exactly how a contract that never implemented ERC-721 support
///      behaves from the token's point of view.
contract MockWallet {
    bool public immutable canReceive;

    constructor(bool canReceive_) {
        canReceive = canReceive_;
    }

    function acceptRing(address ring, uint256 tokenId) external {
        IJoyRingsAccept(ring).accept(tokenId, "");
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        return canReceive ? this.onERC721Received.selector : bytes4(0);
    }
}
