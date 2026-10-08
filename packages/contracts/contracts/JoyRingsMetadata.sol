// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title JoyRingsMetadata — turns a ring's stored facts into its tokenURI.
/// @notice Pure presentation, no storage and no owner. It lives apart from
///         JoyRings only because the two together are bigger than the
///         24,576-byte limit on a single contract. JoyRings takes this
///         contract's address in its constructor and can never point anywhere
///         else, so splitting them changes nothing about what is permanent:
///         the metadata of every ring is fixed exactly as if it were one file.
contract JoyRingsMetadata {
    using Strings for uint256;

    /// Everything tokenURI shows, gathered by JoyRings from its own storage.
    struct Token {
        uint256 tokenId;
        string name;
        string material;      // the word, looked up by JoyRings
        string gem;
        uint16 size;
        uint64 mintedAt;
        string inscription;
        uint256 pairedWith;   // 0 when minted alone
        uint64 acceptedAt;    // 0 when never accepted
        uint256 witnesses;    // of the latest union; 0 when none
        uint8 occasion;       // of the latest union; ignored when acceptedAt is 0
        string imageURI;
        string animationURI;  // "" when none
        string externalBaseURI; // "" leaves external_url out
    }

    /// The occasions the metadata names. The contract stores any number, so
    /// the website can add occasions later; a number this list does not know
    /// simply leaves the trait out rather than inventing a word for it.
    function occasion(uint8 index) public pure returns (string memory) {
        // 5 is a question of the asker's own, which has no name to give it.
        if (index == 5 || index > 9) return "";
        return [
            "Marriage", "Valentine", "Renewed vows", "Friendship", "Co-founders", "",
            "Partners", "Moving in", "Wedding party", "Godparent"
        ][index];
    }

    function tokenURI(Token calldata t) external pure returns (string memory) {
        uint256 circ = circumferenceTenths(t.size);

        string memory attrs = string.concat(
            '[{"trait_type":"Model","value":"', t.name,
            '"},{"trait_type":"Material","value":"', t.material,
            '"},{"trait_type":"Gem","value":"', t.gem,
            '"},{"trait_type":"Size (US)","value":"', _sizeString(t.size),
            '"},{"trait_type":"Size (EU)","value":"', ((circ + 5) / 10).toString(),
            '"},{"trait_type":"Inner circumference (mm)","value":"', _tenthsString(circ),
            '"},{"display_type":"date","trait_type":"Minted","value":', uint256(t.mintedAt).toString(),
            "}"
        );
        if (bytes(t.inscription).length > 0) {
            attrs = string.concat(attrs, ',{"trait_type":"Inscription","value":"', t.inscription, '"}');
        }
        if (t.pairedWith != 0) {
            attrs = string.concat(
                attrs,
                ',{"trait_type":"Paired with","value":"#',
                t.pairedWith.toString(),
                '"}'
            );
        }
        if (t.acceptedAt != 0) {
            attrs = string.concat(
                attrs,
                ',{"display_type":"date","trait_type":"Accepted","value":',
                uint256(t.acceptedAt).toString(),
                "}"
            );
        }
        if (t.acceptedAt != 0 && bytes(occasion(t.occasion)).length > 0) {
            attrs = string.concat(attrs, ',{"trait_type":"Occasion","value":"', occasion(t.occasion), '"}');
        }
        if (t.witnesses != 0) {
            attrs = string.concat(
                attrs,
                ',{"display_type":"number","trait_type":"Witnesses","value":',
                t.witnesses.toString(),
                "}"
            );
        }
        attrs = string.concat(attrs, "]");

        string memory media = string.concat('"image":"', t.imageURI, '"');
        if (bytes(t.animationURI).length > 0) {
            media = string.concat(media, ',"animation_url":"', t.animationURI, '"');
        }

        // A link home from every wallet and marketplace that shows the token.
        string memory external_ = bytes(t.externalBaseURI).length > 0
            ? string.concat(',"external_url":"', t.externalBaseURI, t.tokenId.toString(), '"')
            : "";

        string memory json = string.concat(
            '{"name":"', t.name, " #", t.tokenId.toString(),
            '","description":"', _article(t.material), " ", t.material,
            // Base, not Ethereum: this line sits under a marketplace badge that
            // already says Base, and it cannot be edited after deployment.
            " ring that lives on Base forever, secured by Ethereum. Size, date and inscription are written into the chain and can never be changed.",
            '",', media, external_, ',"attributes":', attrs, "}"
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// ISO 8653 defines a ring size as its inner circumference. US size s (in
    /// half-steps) has inner diameter 11.63mm + 0.4064mm per half-step; the
    /// circumference follows from pi. Returned in tenths of a millimetre so
    /// US 7 reads back as 544 (54.4mm, EU size 54).
    function circumferenceTenths(uint16 size) public pure returns (uint256) {
        uint256 diameterMicrons = 11630 + (4064 * uint256(size)) / 10;
        uint256 circumferenceMicrons = (314159 * diameterMicrons) / 100000;
        return (circumferenceMicrons + 50) / 100;
    }

    /// "A Gold ring", "An Amber ring": the vocabulary can now grow past the
    /// words that happened to start with a consonant.
    function _article(string memory word) internal pure returns (string memory) {
        bytes memory b = bytes(word);
        if (b.length == 0) return "A";
        bytes1 c = b[0];
        return (c == "A" || c == "E" || c == "I" || c == "O" || c == "U") ? "An" : "A";
    }

    function _sizeString(uint16 size) internal pure returns (string memory) {
        uint256 whole = size / 2;
        return size % 2 == 0 ? whole.toString() : string.concat(whole.toString(), ".5");
    }

    function _tenthsString(uint256 tenths) internal pure returns (string memory) {
        return string.concat((tenths / 10).toString(), ".", (tenths % 10).toString());
    }
}
