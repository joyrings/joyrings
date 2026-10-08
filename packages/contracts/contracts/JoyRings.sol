// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {JoyRingsMetadata} from "./JoyRingsMetadata.sol";

/// @title JoyRings — wedding & engagement rings that live on Ethereum forever.
/// @notice One contract, many ring models. Models are catalog entries added by
///         the owner (no per-design deployments). Size and inscription are chosen
///         by the buyer at mint time and written into the token permanently as
///         attributes; the artwork itself is a per-model IPFS asset.
///         Rings are priced in USDC, paid straight to the treasury, with an
///         optional thank-you share to whoever referred the buyer.
///         A built-in proposal flow lets an owner promise a ring to a specific
///         wallet, or by link to someone who has no wallet yet: the ring is
///         locked until the recipient accepts, declines, or the proposal
///         expires. Every accepted proposal is recorded forever as a numbered
///         Union, which the certificate page reads back.
contract JoyRings is ERC721, ERC721Enumerable, ERC2981, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct RingModel {
        string name;         // "Solitaire", "Donut Glaze"...
        uint8 material;      // index into JoyRingsMetadata.material()
        uint8 gem;           // index into JoyRingsMetadata.gem()
        uint128 priceUsdc;   // 6 decimals, e.g. 5_000000 = 5 USDC
        uint32 maxSupply;    // 0 = open edition
        uint32 minted;
        bool active;
        string imageURI;     // ipfs://... still artwork for this model
        string animationURI; // ipfs://... optional mp4/webm loop, "" if none
    }

    struct RingToken {
        uint32 modelId;
        uint16 size;        // US ring size in half-steps: 6..27 => US 3.0..13.5
        uint64 mintedAt;
        string inscription;   // chosen at mint, immutable forever
    }

    struct Proposal {
        address from;
        /// True when `to` is not the recipient's wallet but the address of a
        /// throwaway key that travels in the link (see proposeByLink). Packs
        /// into the slot `from` leaves free, so it costs no extra storage.
        bool byLink;
        /// What is being asked: 0 marriage, 1 Valentine, 2 renewed vows,
        /// 3 friendship, 4 co-founders, 5 a question of their own. Stored, not
        /// checked: the website can learn new occasions without a redeploy,
        /// and the metadata simply names the ones it knows. Also packs into
        /// the slot after `from`.
        uint8 occasion;
        /// The room the question is asked in, a number the website draws.
        /// Chosen by the asker; for a preset occasion it is usually that
        /// occasion's own room.
        uint8 theme;
        address to;
        uint64 deadline;
        string message;
        /// The asker's words on the yes button, or empty for the occasion's
        /// default. There is deliberately no field for the other button: the
        /// way to say no is always labelled by the website, the same way,
        /// because a question where both buttons say yes is not a question.
        string yesLabel;
    }

    /// Written once, when a proposal is accepted, and never touched again.
    /// This is the certificate. A ring can be asked with more than once (it
    /// can be resold, or offered again to renew a vow), so unions are keyed by
    /// their own number rather than by the ring: a later yes adds a union, it
    /// never overwrites the one somebody already framed and shared.
    struct Union {
        uint256 tokenId;
        address proposer;
        address recipient;
        uint64 acceptedAt;
        uint8 occasion;       // carried over from the proposal
        uint8 theme;          // carried over from the proposal
        string message;
        /// What they said back, in their own words, or empty. Written by the
        /// person saying yes, in the same transaction.
        string reply;
    }

    /// Someone who signed a union's certificate after the fact. Kept in
    /// storage rather than only in a log, so the certificate page can read the
    /// guest book with a plain call, no indexer. Wallet, time and flag share
    /// one slot.
    struct Witness {
        address wallet;
        uint64 signedAt;
        /// Set by either of the couple. The signature still counts; the page
        /// just stops showing the note. It stays in the Witnessed event, as
        /// everything on a chain does, and the UI says so.
        bool hidden;
        string note;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public immutable usdc;

    /// Builds tokenURI. Fixed at deployment and never replaceable, so the
    /// metadata is exactly as permanent as if it were assembled in here.
    JoyRingsMetadata public immutable metadata;

    uint256 public nextModelId;
    uint256 public nextTokenId = 1;

    /// The words a model's material and gem indices stand for. Append-only
    /// (see addMaterial), which is what lets the catalog grow into new
    /// materials without a new contract while every existing ring keeps
    /// exactly the metadata it was minted with.
    string[] public materials;
    string[] public gems;

    mapping(uint256 => RingModel) internal models;
    mapping(uint256 => RingToken) internal rings;
    mapping(uint256 => Proposal) internal proposals;

    /// Unions are numbered from 1 in the order the yeses happened. The number
    /// is the certificate number, and it is stable forever.
    uint256 public unionCount;
    mapping(uint256 => Union) private _unions;

    /// The most recent union made with a ring, or 0 if it was never accepted.
    mapping(uint256 => uint256) public lastUnionOf;

    /// Every union a wallet is on, as asker or answerer, oldest first. Rings
    /// get sold and certificates must not get lost with them: this is how a
    /// couple finds theirs again with no ring left and no indexer to ask.
    mapping(address => uint256[]) private _unionsOf;

    /// The guest book of each union, oldest first, one signature per wallet.
    mapping(uint256 => Witness[]) private _witnesses;
    mapping(uint256 => mapping(address => bool)) public hasWitnessed;

    /// Where every sale is paid, directly. The contract never holds revenue,
    /// so there is no balance here to lose, strand or steal.
    address public treasury;

    /// The other half of a pair, or 0. Written once at mint and never changed:
    /// it records that two rings were made together, which stays true however
    /// the two wallets holding them drift apart afterwards.
    mapping(uint256 => uint256) public pairedWith;

    /// Emergency stop for sales only. Proposals, answers and transfers keep
    /// working: pausing the shop must never freeze a promise someone is
    /// waiting on an answer to.
    bool public paused;

    /// ERC-7572 collection metadata, read by marketplaces for the collection page.
    string private _contractURI;

    /// Prefix for the per-token `external_url` in tokenURI. The token id is
    /// appended, so "https://joyrings.xyz/r/" becomes ".../r/42".
    string private _externalBaseURI;

    /// Limits are counted in Unicode codepoints, not bytes, so "64 characters"
    /// means the same thing in every language the shop is sold in.
    uint256 public constant MAX_INSCRIPTION_CHARS = 64;
    uint256 public constant MAX_MESSAGE_CHARS = 280;

    /// Owner-supplied strings that tokenURI also writes into JSON by hand. A
    /// model name cannot be changed after addModel, so a stray quote in one
    /// would break every token of that model for good.
    uint256 private constant MAX_NAME_CHARS = 64;
    uint256 private constant MAX_URI_CHARS = 512;

    /// A witness writes a wish, not a letter.
    uint256 public constant MAX_WITNESS_NOTE_CHARS = 140;
    /// A button label and an answer are short on purpose.
    uint256 public constant MAX_YES_LABEL_CHARS = 24;
    uint256 public constant MAX_REPLY_CHARS = 140;

    /// Taken off the price of two rings bought together. A pair is the shape
    /// the product is actually for, so it should cost less than doing it twice.
    uint256 public constant PAIR_DISCOUNT_BPS = 1000; // 10%

    /// A thank-you to whoever sent the link a ring was bought through, paid
    /// out of the shop's share: the buyer pays the same price either way.
    uint256 public constant REFERRAL_BPS = 1000; // 10%
    uint16 public constant MIN_SIZE = 6; // US 3.0
    uint16 public constant MAX_SIZE = 27; // US 13.5

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ModelAdded(uint256 indexed modelId, string name, uint256 priceUsdc, uint32 maxSupply);
    event ModelUpdated(uint256 indexed modelId, uint256 priceUsdc, bool active);
    event ModelSupplyCapped(uint256 indexed modelId, uint32 maxSupply);
    event MaterialAdded(uint256 indexed id, string name);
    event GemAdded(uint256 indexed id, string name);
    /// `to` is who ends up holding the ring, `payer` is who signed and paid.
    /// They differ only for a gift, and indexing the owner is what any wall or
    /// dashboard actually wants to filter on.
    event RingMinted(
        uint256 indexed tokenId,
        uint256 indexed modelId,
        address indexed to,
        address payer,
        uint16 size,
        string inscription
    );
    event PairMinted(uint256 indexed tokenIdA, uint256 indexed tokenIdB, uint256 indexed modelId);
    /// For a pair, `tokenId` is the first of the two.
    event ReferralPaid(address indexed referrer, uint256 indexed tokenId, uint256 amount);
    event Witnessed(uint256 indexed unionId, address indexed wallet, uint256 index, string note);
    event WitnessHidden(uint256 indexed unionId, uint256 index);
    event Proposed(uint256 indexed tokenId, address indexed from, address indexed to, uint64 deadline);
    event ProposalAccepted(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        uint256 unionId,
        uint64 acceptedAt
    );
    event ProposalDeclined(uint256 indexed tokenId, address indexed from, address indexed to);
    event ProposalCancelled(uint256 indexed tokenId, address indexed from, address indexed to);
    event PausedSet(bool paused);
    event TreasurySet(address indexed treasury);
    /// ERC-7572: signals marketplaces to re-read contractURI().
    event ContractURIUpdated();
    /// ERC-4906: tells marketplaces a token's metadata changed, so they drop
    /// their cached copy instead of showing yesterday's artwork or traits.
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ModelNotFound();
    error ModelNotActive();
    error InvalidTrait();
    error InvalidSupply();
    error SoldOut();
    error InvalidSize();
    error TextTooLong();
    error InvalidCharacter();
    error NotRingOwner();
    error RingIsPromised();
    error NoActiveProposal();
    error NotProposalRecipient();
    error ProposalExpired();
    error CannotProposeToSelf();
    error InvalidDeadline();
    error ZeroAddress();
    error ShopPaused();
    error RescueFailed();
    error NoSuchUnion();
    error AlreadyWitnessed();
    error CannotWitnessOwnUnion();
    error NotPartOfUnion();

    constructor(address initialOwner, address usdcToken, address metadataRenderer)
        ERC721("JoyRings", "JOYR")
        Ownable(initialOwner)
    {
        if (usdcToken == address(0) || metadataRenderer == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);
        metadata = JoyRingsMetadata(metadataRenderer);

        // The launch vocabularies. Order is the stored index: mirror it exactly
        // in apps/web/src/lib/catalog.ts, and only ever append.
        string[13] memory launchMaterials = [
            "Gold", "Rose Gold", "Silver", "Platinum", "Steel",
            "Copper", "Glass", "Plastic", "Rubber", "Cotton",
            "White Gold", "Wood", "Bronze"
        ];
        for (uint256 i = 0; i < launchMaterials.length; i++) materials.push(launchMaterials[i]);
        string[6] memory launchGems = ["None", "Diamond", "Ruby", "Sapphire", "Emerald", "Amethyst"];
        for (uint256 i = 0; i < launchGems.length; i++) gems.push(launchGems[i]);

        treasury = initialOwner;
        emit TreasurySet(initialOwner);
        _setDefaultRoyalty(initialOwner, 500); // 5%
    }

    // ---------------------------------------------------------------------
    // Collection-level settings (owner)
    // ---------------------------------------------------------------------

    /// @notice ERC-7572. Marketplaces read the collection name, description,
    ///         logo and banner from here.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function setContractURI(string calldata uri) external onlyOwner {
        _contractURI = uri;
        emit ContractURIUpdated();
    }

    /// @notice Prefix for each token's `external_url`. The token id is appended.
    ///         Empty means tokenURI omits the field entirely.
    function externalBaseURI() external view returns (string memory) {
        return _externalBaseURI;
    }

    function setExternalBaseURI(string calldata uri) external onlyOwner {
        _validateText(uri, MAX_URI_CHARS);
        _externalBaseURI = uri;
        _refreshAllMetadata();
    }

    /// @notice Where sales are paid. A multisig, ideally.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    /// @notice Stop and restart sales. Deliberately does not touch the proposal
    ///         flow: a paused shop must not strand a pending promise.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    // ---------------------------------------------------------------------
    // Catalog management (owner)
    // ---------------------------------------------------------------------

    /// @notice A new word a ring can be made of, for a design nothing on the
    ///         list describes. Append-only: a word, once added, keeps its
    ///         number and its spelling forever, so no existing ring's metadata
    ///         can ever change because of this.
    function addMaterial(string calldata name) external onlyOwner {
        _validateText(name, MAX_NAME_CHARS);
        materials.push(name);
        emit MaterialAdded(materials.length - 1, name);
    }

    /// @notice The same for stones.
    function addGem(string calldata name) external onlyOwner {
        _validateText(name, MAX_NAME_CHARS);
        gems.push(name);
        emit GemAdded(gems.length - 1, name);
    }

    function addModel(
        string calldata name,
        uint8 material,
        uint8 gem,
        uint128 priceUsdc,
        uint32 maxSupply,
        string calldata imageURI,
        string calldata animationURI
    ) external onlyOwner returns (uint256 modelId) {
        if (material >= materials.length || gem >= gems.length) revert InvalidTrait();
        _validateText(name, MAX_NAME_CHARS);
        _validateText(imageURI, MAX_URI_CHARS);
        _validateText(animationURI, MAX_URI_CHARS);
        modelId = nextModelId++;
        models[modelId] = RingModel({
            name: name,
            material: material,
            gem: gem,
            priceUsdc: priceUsdc,
            maxSupply: maxSupply,
            minted: 0,
            active: true,
            imageURI: imageURI,
            animationURI: animationURI
        });
        emit ModelAdded(modelId, name, priceUsdc, maxSupply);
    }

    function updateModel(uint256 modelId, uint128 priceUsdc, bool active) external onlyOwner {
        if (modelId >= nextModelId) revert ModelNotFound();
        RingModel storage m = models[modelId];
        m.priceUsdc = priceUsdc;
        m.active = active;
        emit ModelUpdated(modelId, priceUsdc, active);
    }

    /// @notice Close a limited edition early, or put a cap on an open one.
    ///         Editions can only ever get smaller: "one of 50" is a promise
    ///         made to everyone who already bought one, so raising the cap is
    ///         not something this contract can do. The cap can come down to
    ///         exactly what has been minted, which sells the model out.
    function capModelSupply(uint256 modelId, uint32 maxSupply) external onlyOwner {
        if (modelId >= nextModelId) revert ModelNotFound();
        RingModel storage m = models[modelId];
        if (maxSupply == 0 || maxSupply < m.minted) revert InvalidSupply();
        if (m.maxSupply != 0 && maxSupply >= m.maxSupply) revert InvalidSupply();
        m.maxSupply = maxSupply;
        emit ModelSupplyCapped(modelId, maxSupply);
    }

    /// @notice Point a model at its final artwork. Pass an empty string to keep
    ///         the current value for either field.
    function setModelMedia(uint256 modelId, string calldata imageURI, string calldata animationURI)
        external
        onlyOwner
    {
        if (modelId >= nextModelId) revert ModelNotFound();
        _validateText(imageURI, MAX_URI_CHARS);
        _validateText(animationURI, MAX_URI_CHARS);
        RingModel storage m = models[modelId];
        if (bytes(imageURI).length > 0) m.imageURI = imageURI;
        if (bytes(animationURI).length > 0) m.animationURI = animationURI;
        // Tokens are not indexed by model, so every token is flagged. Cheap,
        // and a marketplace re-reading a few extra tokens is harmless.
        _refreshAllMetadata();
    }

    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    /// @notice Mint a ring of a given model with your size and inscription, paid
    ///         in USDC. Approve this contract for the model price first.
    ///         The inscription is written into the chain permanently.
    ///
    ///         `referrer` is whoever sent you the link, or the zero address.
    ///         Every mint function takes one. It never changes what you pay:
    ///         REFERRAL_BPS of the price goes to them instead of the shop.
    ///         Referring yourself is allowed and simply pays nobody.
    function mint(uint256 modelId, uint16 size, string calldata inscription, address referrer)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        return _mintRing(msg.sender, modelId, size, inscription, referrer);
    }

    /// @notice Mint a ring straight into someone else's wallet. You pay, they
    ///         own it from the first block; there is nothing to accept and
    ///         nothing to transfer afterwards.
    ///
    ///         This is a gift, not a proposal. A proposal locks a ring you
    ///         already own until the other person answers, and can come back;
    ///         a gift is final the moment it is mined. Both exist because
    ///         "here, this is yours" and "will you?" are different questions.
    function mintTo(
        address to,
        uint256 modelId,
        uint16 size,
        string calldata inscription,
        address referrer
    ) external nonReentrant returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        return _mintRing(to, modelId, size, inscription, referrer);
    }

    /// @notice What two rings of this model cost bought together.
    function pairPrice(uint256 modelId) public view returns (uint256) {
        if (modelId >= nextModelId) revert ModelNotFound();
        uint256 full = uint256(models[modelId].priceUsdc) * 2;
        return full - (full * PAIR_DISCOUNT_BPS) / 10_000;
    }

    /// @notice Mint two rings of one model, in two sizes, sharing one
    ///         inscription. Both land in your wallet.
    ///
    ///         This is the shape a wedding actually has, and it is what makes
    ///         the proposal flow work properly: keep one, promise the other,
    ///         and when they accept there are two rings in two wallets that
    ///         each know about the other. Nothing here locks them together
    ///         afterwards; either half can be sold, and `pairedWith` goes on
    ///         recording that they were made on the same day regardless.
    function mintPair(
        uint256 modelId,
        uint16 sizeA,
        uint16 sizeB,
        string calldata inscription,
        address referrer
    ) external nonReentrant returns (uint256 tokenIdA, uint256 tokenIdB) {
        return _mintPair(msg.sender, msg.sender, modelId, sizeA, sizeB, inscription, referrer);
    }

    /// @notice The same pair, but the second ring goes straight to them. For
    ///         couples who are past the question and just want matching rings.
    function mintPairTo(
        address partner,
        uint256 modelId,
        uint16 sizeA,
        uint16 sizeB,
        string calldata inscription,
        address referrer
    ) external nonReentrant returns (uint256 tokenIdA, uint256 tokenIdB) {
        if (partner == address(0)) revert ZeroAddress();
        return _mintPair(msg.sender, partner, modelId, sizeA, sizeB, inscription, referrer);
    }

    function _mintPair(
        address ownerA,
        address ownerB,
        uint256 modelId,
        uint16 sizeA,
        uint16 sizeB,
        string calldata inscription,
        address referrer
    ) internal returns (uint256 tokenIdA, uint256 tokenIdB) {
        if (paused) revert ShopPaused();
        if (modelId >= nextModelId) revert ModelNotFound();
        RingModel storage m = models[modelId];
        if (!m.active) revert ModelNotActive();
        // A pair takes two off the edition, so a model with one left cannot
        // sell one: half a pair is not the thing being bought.
        if (m.maxSupply != 0 && uint256(m.minted) + 2 > m.maxSupply) revert SoldOut();
        if (sizeA < MIN_SIZE || sizeA > MAX_SIZE) revert InvalidSize();
        if (sizeB < MIN_SIZE || sizeB > MAX_SIZE) revert InvalidSize();
        _validateText(inscription, MAX_INSCRIPTION_CHARS);

        m.minted += 2;
        tokenIdA = nextTokenId++;
        tokenIdB = nextTokenId++;

        uint64 mintedAt = uint64(block.timestamp);
        rings[tokenIdA] = RingToken({
            modelId: uint32(modelId),
            size: sizeA,
            mintedAt: mintedAt,
            inscription: inscription
        });
        rings[tokenIdB] = RingToken({
            modelId: uint32(modelId),
            size: sizeB,
            mintedAt: mintedAt,
            inscription: inscription
        });
        pairedWith[tokenIdA] = tokenIdB;
        pairedWith[tokenIdB] = tokenIdA;

        _collect(pairPrice(modelId), referrer, tokenIdA);

        // Both states are final before either receiver hook can run.
        _safeMint(ownerA, tokenIdA);
        _safeMint(ownerB, tokenIdB);

        emit RingMinted(tokenIdA, modelId, ownerA, msg.sender, sizeA, inscription);
        emit RingMinted(tokenIdB, modelId, ownerB, msg.sender, sizeB, inscription);
        emit PairMinted(tokenIdA, tokenIdB, modelId);
    }

    /// The buyer is always msg.sender; only the owner of the result varies.
    function _mintRing(
        address to,
        uint256 modelId,
        uint16 size,
        string calldata inscription,
        address referrer
    ) internal returns (uint256 tokenId) {
        if (paused) revert ShopPaused();
        if (modelId >= nextModelId) revert ModelNotFound();
        RingModel storage m = models[modelId];
        if (!m.active) revert ModelNotActive();
        if (m.maxSupply != 0 && m.minted >= m.maxSupply) revert SoldOut();
        if (size < MIN_SIZE || size > MAX_SIZE) revert InvalidSize();
        _validateText(inscription, MAX_INSCRIPTION_CHARS);

        m.minted += 1;
        tokenId = nextTokenId++;
        rings[tokenId] = RingToken({
            modelId: uint32(modelId),
            size: size,
            mintedAt: uint64(block.timestamp),
            inscription: inscription
        });

        _collect(m.priceUsdc, referrer, tokenId);
        _safeMint(to, tokenId);
        emit RingMinted(tokenId, modelId, to, msg.sender, size, inscription);
    }

    /// Takes the price from the buyer: all of it to the treasury, or the
    /// referral share to whoever sent the link and the rest to the treasury.
    function _collect(uint256 price, address referrer, uint256 tokenId) internal {
        if (referrer == address(0) || referrer == msg.sender) {
            usdc.safeTransferFrom(msg.sender, treasury, price);
            return;
        }
        uint256 thanks = (price * REFERRAL_BPS) / 10_000;
        usdc.safeTransferFrom(msg.sender, referrer, thanks);
        usdc.safeTransferFrom(msg.sender, treasury, price - thanks);
        emit ReferralPaid(referrer, tokenId, thanks);
    }

    // ---------------------------------------------------------------------
    // Proposal flow
    // ---------------------------------------------------------------------

    /// @notice Promise a ring to someone. The ring stays in your wallet but is
    ///         locked until they accept, decline, or the deadline passes.
    function propose(
        uint256 tokenId,
        address to,
        string calldata message,
        uint64 deadline,
        uint8 occasion,
        uint8 theme,
        string calldata yesLabel
    ) external {
        _propose(tokenId, to, message, deadline, occasion, theme, yesLabel, false);
    }

    /// @notice Promise a ring to someone who may not have a wallet yet.
    ///
    ///         `key` is the address of a throwaway keypair made in your
    ///         browser. Its private half never touches the chain: it travels
    ///         only inside the link you send them. Whoever opens that link can
    ///         say yes into whatever wallet they have, including one they
    ///         create on the spot, so send it to them and nobody else, like a
    ///         key to a door. Everything else is the same as propose(): the
    ///         ring is locked until they accept, you cancel, or the deadline
    ///         passes.
    function proposeByLink(
        uint256 tokenId,
        address key,
        string calldata message,
        uint64 deadline,
        uint8 occasion,
        uint8 theme,
        string calldata yesLabel
    ) external {
        _propose(tokenId, key, message, deadline, occasion, theme, yesLabel, true);
    }

    function _propose(
        uint256 tokenId,
        address to,
        string calldata message,
        uint64 deadline,
        uint8 occasion,
        uint8 theme,
        string calldata yesLabel,
        bool byLink
    ) internal {
        if (ownerOf(tokenId) != msg.sender) revert NotRingOwner();
        if (to == msg.sender || to == address(0)) revert CannotProposeToSelf();
        // Only a live promise blocks a new one. An expired proposal is dead
        // weight and is simply overwritten, so a ring can never be stranded by
        // a question nobody answered.
        if (_isLocked(tokenId)) revert RingIsPromised();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        _validateText(message, MAX_MESSAGE_CHARS);
        _validateText(yesLabel, MAX_YES_LABEL_CHARS);

        proposals[tokenId] = Proposal({
            from: msg.sender,
            byLink: byLink,
            occasion: occasion,
            theme: theme,
            to: to,
            deadline: deadline,
            message: message,
            yesLabel: yesLabel
        });
        emit Proposed(tokenId, msg.sender, to, deadline);
    }

    /// @notice Say yes. Transfers the ring into your wallet and records the
    ///         moment permanently as a new, numbered Union. `reply` is your
    ///         answer in your own words, kept next to the question; empty is
    ///         fine, the yes is the answer.
    function accept(uint256 tokenId, string calldata reply)
        external
        nonReentrant
        returns (uint256 unionId)
    {
        Proposal memory p = proposals[tokenId];
        if (p.to == address(0)) revert NoActiveProposal();
        // A link proposal's `to` is its key, which must never end up holding
        // the ring: its private half is sitting in a chat somewhere.
        if (msg.sender != p.to || p.byLink) revert NotProposalRecipient();
        return _accept(tokenId, p, msg.sender, reply);
    }

    /// @notice Say yes to a proposal that came as a link, into your own wallet.
    ///
    ///         `signature` is made with the link's key over this contract, the
    ///         chain, the ring, the deadline and the wallet saying yes. Binding
    ///         the wallet is what makes it safe to send: someone who copies the
    ///         signature out of the mempool can only accept on your behalf,
    ///         into your wallet.
    function acceptByLink(uint256 tokenId, bytes calldata signature, string calldata reply)
        external
        nonReentrant
        returns (uint256 unionId)
    {
        Proposal memory p = proposals[tokenId];
        if (p.to == address(0) || !p.byLink) revert NoActiveProposal();
        if (msg.sender == p.from) revert CannotProposeToSelf();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), tokenId, p.deadline, msg.sender))
        );
        if (ECDSA.recover(digest, signature) != p.to) revert NotProposalRecipient();
        return _accept(tokenId, p, msg.sender, reply);
    }

    function _accept(
        uint256 tokenId,
        Proposal memory p,
        address recipient,
        string calldata reply
    ) internal returns (uint256 unionId) {
        if (block.timestamp > p.deadline) revert ProposalExpired();
        _validateText(reply, MAX_REPLY_CHARS);

        delete proposals[tokenId]; // unlock before transfer
        uint64 acceptedAt = uint64(block.timestamp);
        unionId = ++unionCount;
        _unions[unionId] = Union({
            tokenId: tokenId,
            proposer: p.from,
            recipient: recipient,
            acceptedAt: acceptedAt,
            occasion: p.occasion,
            theme: p.theme,
            message: p.message,
            reply: reply
        });
        lastUnionOf[tokenId] = unionId;
        _unionsOf[p.from].push(unionId);
        _unionsOf[recipient].push(unionId);
        // safeTransfer so a contract wallet that cannot hold ERC-721 reverts
        // here rather than swallowing the ring. State is already final and the
        // function is nonReentrant, so the receiver hook has nothing to exploit.
        _safeTransfer(p.from, recipient, tokenId);
        emit ProposalAccepted(tokenId, p.from, recipient, unionId, acceptedAt);
        emit MetadataUpdate(tokenId); // it has an Accepted date now
    }

    /// @notice Say no. The ring unlocks in the sender's wallet.
    ///         Only while the question stands: once the deadline has passed the
    ///         ring has already unlocked itself and there is nothing left to
    ///         answer, so declining then would write a reply to a question that
    ///         is no longer being asked. Symmetric with accept().
    ///         A link proposal has no wallet on the other end to decline from;
    ///         a no there is silence until the deadline, or the asker cancelling.
    function decline(uint256 tokenId) external {
        Proposal memory p = proposals[tokenId];
        if (p.to == address(0)) revert NoActiveProposal();
        if (msg.sender != p.to) revert NotProposalRecipient();
        if (block.timestamp > p.deadline) revert ProposalExpired();

        delete proposals[tokenId];
        emit ProposalDeclined(tokenId, p.from, p.to);
    }

    // ---------------------------------------------------------------------
    // Witnesses
    // ---------------------------------------------------------------------

    /// @notice Sign a union's certificate as a witness, with an optional wish.
    ///         Anyone may, once per wallet, except the two people it is about:
    ///         a witness is somebody else by definition.
    function witness(uint256 unionId, string calldata note) external {
        Union storage u = _unions[unionId];
        if (u.acceptedAt == 0) revert NoSuchUnion();
        if (msg.sender == u.proposer || msg.sender == u.recipient) revert CannotWitnessOwnUnion();
        if (hasWitnessed[unionId][msg.sender]) revert AlreadyWitnessed();
        _validateText(note, MAX_WITNESS_NOTE_CHARS);

        hasWitnessed[unionId][msg.sender] = true;
        _witnesses[unionId].push(
            Witness({wallet: msg.sender, signedAt: uint64(block.timestamp), hidden: false, note: note})
        );
        emit Witnessed(unionId, msg.sender, _witnesses[unionId].length - 1, note);
        // The ring's metadata counts witnesses of its latest union.
        if (lastUnionOf[u.tokenId] == unionId) emit MetadataUpdate(u.tokenId);
    }

    /// @notice Hide a witness's note from the certificate. For the couple
    ///         only: it is their certificate, and a guest book open to anyone
    ///         will one day get something written in it that should not stay
    ///         on display. The signature itself keeps counting.
    function hideWitness(uint256 unionId, uint256 index) external {
        Union storage u = _unions[unionId];
        if (msg.sender != u.proposer && msg.sender != u.recipient) revert NotPartOfUnion();
        _witnesses[unionId][index].hidden = true;
        emit WitnessHidden(unionId, index);
    }

    function witnessCount(uint256 unionId) public view returns (uint256) {
        return _witnesses[unionId].length;
    }

    /// @notice One entry of the guest book, oldest first. A hidden note comes
    ///         back empty. The page reads a batch of these in one multicall.
    function witnessAt(uint256 unionId, uint256 index) external view returns (Witness memory w) {
        w = _witnesses[unionId][index];
        if (w.hidden) w.note = "";
    }

    /// @notice Withdraw the question. Callable by whoever asked, and by the
    ///         current owner, so a ring that changed hands with an expired
    ///         proposal still attached can always be cleaned up.
    function cancelProposal(uint256 tokenId) external {
        Proposal memory p = proposals[tokenId];
        if (p.to == address(0)) revert NoActiveProposal();
        if (msg.sender != p.from && msg.sender != ownerOf(tokenId)) revert NotRingOwner();

        delete proposals[tokenId];
        emit ProposalCancelled(tokenId, p.from, p.to);
    }

    // ---------------------------------------------------------------------
    // Metadata — assembled on-chain, artwork lives on IPFS
    // ---------------------------------------------------------------------

    /// Assembled on read by the metadata contract from what is stored here,
    /// so a change to the artwork, the external_url base or a new union shows
    /// up in every wallet at once. The artwork itself lives on IPFS.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        RingToken storage r = rings[tokenId];
        RingModel storage m = models[r.modelId];
        uint256 unionId = lastUnionOf[tokenId];
        return metadata.tokenURI(
            JoyRingsMetadata.Token({
                tokenId: tokenId,
                name: m.name,
                material: materials[m.material],
                gem: gems[m.gem],
                size: r.size,
                mintedAt: r.mintedAt,
                inscription: r.inscription,
                pairedWith: pairedWith[tokenId],
                acceptedAt: unionId == 0 ? 0 : _unions[unionId].acceptedAt,
                witnesses: _witnesses[unionId].length,
                occasion: _unions[unionId].occasion,
                imageURI: m.imageURI,
                animationURI: m.animationURI,
                externalBaseURI: _externalBaseURI
            })
        );
    }

    // ---------------------------------------------------------------------
    // Views for the app
    // ---------------------------------------------------------------------

    function getModel(uint256 modelId) external view returns (RingModel memory) {
        if (modelId >= nextModelId) revert ModelNotFound();
        return models[modelId];
    }

    function getRing(uint256 tokenId) external view returns (RingToken memory) {
        _requireOwned(tokenId);
        return rings[tokenId];
    }

    /// @notice The open question on a ring together with the ring's latest
    ///         union, read in one call. The proposal page polls both, and it
    ///         must never see one of them from before an answer and the other
    ///         from after it: a decline would read as a yes, or a yes as
    ///         nothing at all.
    function getProposalState(uint256 tokenId)
        external
        view
        returns (Proposal memory proposal, uint256 unionId)
    {
        return (proposals[tokenId], lastUnionOf[tokenId]);
    }

    /// @notice A certificate by number. Empty (acceptedAt == 0) if there is no
    ///         such union yet.
    function getUnion(uint256 unionId) external view returns (Union memory) {
        return _unions[unionId];
    }

    /// @notice The certificate numbers a wallet is on, whoever holds the rings now.
    function unionsOf(address who) external view returns (uint256[] memory) {
        return _unionsOf[who];
    }


    /// @notice Recover a token sent here by mistake. Revenue never lands here,
    ///         it goes straight to the treasury at mint, so anything this
    ///         contract holds, USDC included, is somebody's slip of the finger
    ///         and would otherwise be stuck forever.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Recover ETH. The contract is not payable, so this can only ever
    ///         have a balance if ETH was forced in (selfdestruct, or a block
    ///         reward paid here). Rare, but otherwise unrecoverable.
    function rescueETH(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert RescueFailed();
    }

    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// Any well-formed UTF-8 is accepted, so a vow can be written in any
    /// language. Only three things are refused, and only because tokenURI
    /// assembles its JSON by hand: a double quote, a backslash, and control
    /// characters. Everything else, including every non-ASCII codepoint, is
    /// legal inside a JSON string exactly as it stands, so no escaping is
    /// needed and none is invented.
    ///
    /// The length limit counts codepoints rather than bytes: "64 characters"
    /// has to mean the same in Cyrillic as in Latin. Walking the string to
    /// validate it counts them for free. Rejecting overlong forms, surrogates
    /// and out-of-range sequences keeps the stored bytes decodable, so the
    /// metadata cannot be turned into mojibake by a crafted input.
    function _validateText(string calldata text, uint256 maxChars) internal pure {
        bytes calldata b = bytes(text);
        uint256 i = 0;
        uint256 chars = 0;

        while (i < b.length) {
            uint8 lead = uint8(b[i]);
            uint256 width;

            if (lead < 0x80) {
                if (lead < 0x20 || lead == 0x7F || lead == 0x22 || lead == 0x5C) {
                    revert InvalidCharacter();
                }
                width = 1;
            } else if (lead >= 0xC2 && lead <= 0xDF) {
                width = 2;
            } else if (lead >= 0xE0 && lead <= 0xEF) {
                width = 3;
            } else if (lead >= 0xF0 && lead <= 0xF4) {
                width = 4;
            } else {
                // 0x80..0xC1 and 0xF5..0xFF are never a valid lead byte.
                revert InvalidCharacter();
            }

            if (i + width > b.length) revert InvalidCharacter();
            for (uint256 j = 1; j < width; j++) {
                uint8 cont = uint8(b[i + j]);
                if (cont < 0x80 || cont > 0xBF) revert InvalidCharacter();
            }

            if (width == 3) {
                uint8 second = uint8(b[i + 1]);
                if (lead == 0xE0 && second < 0xA0) revert InvalidCharacter(); // overlong
                if (lead == 0xED && second > 0x9F) revert InvalidCharacter(); // UTF-16 surrogate
            } else if (width == 4) {
                uint8 second = uint8(b[i + 1]);
                if (lead == 0xF0 && second < 0x90) revert InvalidCharacter(); // overlong
                if (lead == 0xF4 && second > 0x8F) revert InvalidCharacter(); // beyond U+10FFFF
            }

            i += width;
            chars += 1;
            if (chars > maxChars) revert TextTooLong();
        }
    }

    /// ERC-4906 for every token minted so far. tokenURI is assembled on read,
    /// so a collection-wide change (artwork, external_url) is live at once;
    /// this is what tells marketplaces to stop serving their cached copy.
    function _refreshAllMetadata() internal {
        if (nextTokenId > 1) emit BatchMetadataUpdate(1, nextTokenId - 1);
    }

    /// True while a promise is live. `to` and `deadline` share one storage
    /// slot, so checking the deadline costs nothing over checking the address.
    function _isLocked(uint256 tokenId) internal view returns (bool) {
        Proposal storage p = proposals[tokenId];
        return p.to != address(0) && block.timestamp <= p.deadline;
    }

    /// Rings under a live proposal are locked: no transfers, no sales. Once the
    /// deadline passes the lock lifts on its own, which is what the site
    /// promises: silence costs the owner a question, never the ring.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        if (_isLocked(tokenId)) revert RingIsPromised();
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC2981)
        returns (bool)
    {
        // 0x49064906 is ERC-4906 (metadata update events).
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }
}
