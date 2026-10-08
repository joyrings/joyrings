import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const DAY = 24 * 60 * 60;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
/** Every mint takes a referrer; most tests are about something else. */
const NO_REF = ethers.ZeroAddress;
/** Proposals carry an occasion; 0 is marriage, the default. */
const MARRIAGE = 0;

/** The open question on a ring; getProposalState reads it with the last union. */
async function proposalOf(
  ring: { getProposalState(id: number): Promise<readonly [Awaited<ReturnType<typeof readProposalShape>>, bigint]> },
  id: number
) {
  return (await ring.getProposalState(id))[0];
}
declare function readProposalShape(): Promise<{
  from: string;
  to: string;
  byLink: boolean;
  occasion: bigint;
  theme: bigint;
  deadline: bigint;
  message: string;
  yesLabel: string;
}>;

describe("JoyRings", () => {
  async function deployFixture() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const Metadata = await ethers.getContractFactory("JoyRingsMetadata");
    const metadata = await Metadata.deploy();

    const JoyRings = await ethers.getContractFactory("JoyRings");
    const ring = await JoyRings.deploy(
      owner.address,
      await usdc.getAddress(),
      await metadata.getAddress()
    );
    const ringAddress = await ring.getAddress();

    // model 0: gold + diamond, 25 USDC, limited to 3
    await ring.addModel("Solitaire", 0, 1, USDC(25), 3, "ipfs://model0", "");
    // model 1: silver band, open edition, with an animation
    await ring.addModel("The Classic", 2, 0, USDC(9), 0, "ipfs://model1", "ipfs://anim1");

    // everyone starts funded and approved
    for (const account of [alice, bob, carol]) {
      await usdc.mint(account.address, USDC(1000));
      await usdc.connect(account).approve(ringAddress, USDC(1000));
    }

    return { ring, usdc, metadata, owner, alice, bob, carol, dave };
  }

  async function readInscription(
    ring: { getRing: (id: number) => Promise<{ inscription: string }> },
    id: number
  ) {
    return (await ring.getRing(id)).inscription;
  }

  describe("catalog", () => {
    it("only owner can add models", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await expect(
        ring.connect(alice).addModel("Hack", 0, 0, 0, 0, "ipfs://x", "")
      ).to.be.revertedWithCustomError(ring, "OwnableUnauthorizedAccount");
    });

    it("stores model data", async () => {
      const { ring } = await loadFixture(deployFixture);
      const m = await ring.getModel(0);
      expect(m.name).to.equal("Solitaire");
      expect(m.material).to.equal(0);
      expect(m.gem).to.equal(1);
      expect(m.priceUsdc).to.equal(USDC(25));
      expect(m.maxSupply).to.equal(3);
      expect(await ring.nextModelId()).to.equal(2);
    });

    it("updateModel changes price and active flag", async () => {
      const { ring } = await loadFixture(deployFixture);
      await ring.updateModel(1, USDC(15), false);
      const m = await ring.getModel(1);
      expect(m.priceUsdc).to.equal(USDC(15));
      expect(m.active).to.equal(false);
    });

    it("setModelMedia updates artwork, empty strings keep the old value", async () => {
      const { ring } = await loadFixture(deployFixture);
      await ring.setModelMedia(0, "ipfs://new0", "ipfs://anim0");
      let m = await ring.getModel(0);
      expect(m.imageURI).to.equal("ipfs://new0");
      expect(m.animationURI).to.equal("ipfs://anim0");

      await ring.setModelMedia(0, "", "");
      m = await ring.getModel(0);
      expect(m.imageURI).to.equal("ipfs://new0");
      expect(m.animationURI).to.equal("ipfs://anim0");
    });

    it("addModel refuses what would break the hand-built JSON", async () => {
      const { ring } = await loadFixture(deployFixture);
      await expect(
        ring.addModel('The "One"', 0, 0, USDC(9), 0, "ipfs://x", "")
      ).to.be.revertedWithCustomError(ring, "InvalidCharacter");
      await expect(
        ring.addModel("Fine", 0, 0, USDC(9), 0, 'ipfs://x"', "")
      ).to.be.revertedWithCustomError(ring, "InvalidCharacter");
      await expect(
        ring.addModel("Fine", 0, 0, USDC(9), 0, "ipfs://x", "ipfs://y\n")
      ).to.be.revertedWithCustomError(ring, "InvalidCharacter");
      await expect(
        ring.addModel("x".repeat(65), 0, 0, USDC(9), 0, "ipfs://x", "")
      ).to.be.revertedWithCustomError(ring, "TextTooLong");
      await expect(
        ring.addModel("Fine", 13, 0, USDC(9), 0, "ipfs://x", "")
      ).to.be.revertedWithCustomError(ring, "InvalidTrait");
      await expect(
        ring.addModel("Fine", 0, 6, USDC(9), 0, "ipfs://x", "")
      ).to.be.revertedWithCustomError(ring, "InvalidTrait");
    });

    it("setModelMedia refuses a URI that would break the JSON", async () => {
      const { ring } = await loadFixture(deployFixture);
      await expect(ring.setModelMedia(0, 'ipfs://"', "")).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );
    });

    describe("capModelSupply", () => {
      it("closes an edition down to exactly what was minted", async () => {
        const { ring, alice } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 14, "", NO_REF); // model 0 is limited to 3
        await expect(ring.capModelSupply(0, 1))
          .to.emit(ring, "ModelSupplyCapped")
          .withArgs(0, 1);
        await expect(ring.connect(alice).mint(0, 14, "", NO_REF)).to.be.revertedWithCustomError(
          ring,
          "SoldOut"
        );
      });

      it("can cap an open edition", async () => {
        const { ring } = await loadFixture(deployFixture);
        await ring.capModelSupply(1, 100); // model 1 is open
        expect((await ring.getModel(1)).maxSupply).to.equal(100);
      });

      it("never raises a cap, reopens an edition, or goes below what exists", async () => {
        const { ring, alice } = await loadFixture(deployFixture);
        await ring.connect(alice).mintPair(0, 14, 16, "", NO_REF);

        await expect(ring.capModelSupply(0, 3)).to.be.revertedWithCustomError(ring, "InvalidSupply");
        await expect(ring.capModelSupply(0, 4)).to.be.revertedWithCustomError(ring, "InvalidSupply");
        await expect(ring.capModelSupply(0, 0)).to.be.revertedWithCustomError(ring, "InvalidSupply");
        await expect(ring.capModelSupply(0, 1)).to.be.revertedWithCustomError(ring, "InvalidSupply");
        await expect(ring.capModelSupply(9, 1)).to.be.revertedWithCustomError(ring, "ModelNotFound");
      });

      it("is owner-only", async () => {
        const { ring, alice } = await loadFixture(deployFixture);
        await expect(ring.connect(alice).capModelSupply(0, 1)).to.be.revertedWithCustomError(
          ring,
          "OwnableUnauthorizedAccount"
        );
      });
    });
  });

  describe("mint", () => {
    it("mints with size and inscription, paying the treasury", async () => {
      const { ring, usdc, owner, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).mint(0, 15, "A+J forever", NO_REF))
        .to.emit(ring, "RingMinted")
        .withArgs(1, 0, alice.address, alice.address, 15, "A+J forever");

      expect(await ring.ownerOf(1)).to.equal(alice.address);
      // Revenue goes straight through: the treasury (the owner, at deploy) is
      // paid and the contract itself holds nothing.
      expect(await usdc.balanceOf(owner.address)).to.equal(USDC(25));
      expect(await usdc.balanceOf(await ring.getAddress())).to.equal(0n);
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(975));

      const r = await ring.getRing(1);
      expect(r.modelId).to.equal(0);
      expect(r.size).to.equal(15);
      expect(r.inscription).to.equal("A+J forever");
    });

    it("reverts when USDC was not approved", async () => {
      const { ring, usdc, owner } = await loadFixture(deployFixture);
      await usdc.mint(owner.address, USDC(100));
      await expect(ring.connect(owner).mint(0, 14, "", NO_REF)).to.be.revertedWithCustomError(
        usdc,
        "ERC20InsufficientAllowance"
      );
    });

    it("reverts when the buyer is short on USDC", async () => {
      const { ring, usdc, owner } = await loadFixture(deployFixture);
      await usdc.connect(owner).approve(await ring.getAddress(), USDC(1000));
      await expect(ring.connect(owner).mint(0, 14, "", NO_REF)).to.be.revertedWithCustomError(
        usdc,
        "ERC20InsufficientBalance"
      );
    });

    it("rejects inactive model and unknown model", async () => {
      const { ring, alice, owner } = await loadFixture(deployFixture);
      await ring.connect(owner).updateModel(0, USDC(25), false);
      await expect(ring.connect(alice).mint(0, 15, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "ModelNotActive"
      );
      await expect(ring.connect(alice).mint(99, 15, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "ModelNotFound"
      );
    });

    it("enforces max supply", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 12, "", NO_REF);
      await ring.connect(alice).mint(0, 13, "", NO_REF);
      await ring.connect(alice).mint(0, 14, "", NO_REF);
      await expect(ring.connect(alice).mint(0, 15, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "SoldOut"
      );
    });

    it("validates size bounds", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).mint(0, 5, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidSize"
      );
      await expect(ring.connect(alice).mint(0, 28, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidSize"
      );
    });

    it("rejects inscriptions that could break JSON", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).mint(0, 15, 'evil"', NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );
      await expect(ring.connect(alice).mint(0, 15, "back\\slash", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );
      await expect(ring.connect(alice).mint(0, 15, "line\nbreak", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );
      await expect(
        ring.connect(alice).mint(0, 15, "x".repeat(65), NO_REF)
      ).to.be.revertedWithCustomError(ring, "TextTooLong");
    });

    it("mintTo puts the ring in someone else's wallet and charges the sender", async () => {
      const { ring, usdc, alice, bob } = await loadFixture(deployFixture);

      await expect(ring.connect(alice).mintTo(bob.address, 0, 15, "for you", NO_REF))
        .to.emit(ring, "RingMinted")
        .withArgs(1, 0, bob.address, alice.address, 15, "for you");

      expect(await ring.ownerOf(1)).to.equal(bob.address);
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(975));
      expect(await usdc.balanceOf(bob.address)).to.equal(USDC(1000));

      // A gift is final: nothing is promised, so nothing is locked.
      expect((await proposalOf(ring, 1)).to).to.equal(ethers.ZeroAddress);
      await ring.connect(bob).transferFrom(bob.address, alice.address, 1);
      expect(await ring.ownerOf(1)).to.equal(alice.address);
    });

    it("mintTo refuses the zero address and obeys the same rules as mint", async () => {
      const { ring, owner, alice, bob } = await loadFixture(deployFixture);

      await expect(
        ring.connect(alice).mintTo(ethers.ZeroAddress, 0, 15, "", NO_REF)
      ).to.be.revertedWithCustomError(ring, "ZeroAddress");
      await expect(
        ring.connect(alice).mintTo(bob.address, 0, 5, "", NO_REF)
      ).to.be.revertedWithCustomError(ring, "InvalidSize");
      await expect(
        ring.connect(alice).mintTo(bob.address, 0, 15, 'nope"', NO_REF)
      ).to.be.revertedWithCustomError(ring, "InvalidCharacter");

      await ring.connect(owner).setPaused(true);
      await expect(
        ring.connect(alice).mintTo(bob.address, 0, 15, "", NO_REF)
      ).to.be.revertedWithCustomError(ring, "ShopPaused");
    });

    it("gifting refuses a wallet that cannot hold the ring", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      const MockWallet = await ethers.getContractFactory("MockWallet");
      const broken = await MockWallet.deploy(false);

      await expect(
        ring.connect(alice).mintTo(await broken.getAddress(), 0, 15, "", NO_REF)
      ).to.be.revertedWithCustomError(ring, "ERC721InvalidReceiver");
    });

    it("mints a pair: two sizes, one inscription, both to the buyer", async () => {
      const { ring, usdc, owner, alice } = await loadFixture(deployFixture);

      // Model 1 is the open edition at 9 USDC, so a pair costs 18 less 10%.
      await expect(ring.connect(alice).mintPair(1, 14, 18, "14.02.2026", NO_REF))
        .to.emit(ring, "PairMinted")
        .withArgs(1, 2, 1);

      expect(await ring.ownerOf(1)).to.equal(alice.address);
      expect(await ring.ownerOf(2)).to.equal(alice.address);
      expect(await ring.pairedWith(1)).to.equal(2);
      expect(await ring.pairedWith(2)).to.equal(1);

      const a = await ring.getRing(1);
      const b = await ring.getRing(2);
      expect(a.size).to.equal(14);
      expect(b.size).to.equal(18);
      expect(a.inscription).to.equal("14.02.2026");
      expect(b.inscription).to.equal("14.02.2026");
      expect(a.mintedAt).to.equal(b.mintedAt);

      expect(await ring.pairPrice(1)).to.equal(USDC(16.2));
      expect(await usdc.balanceOf(owner.address)).to.equal(USDC(16.2));
      expect(await usdc.balanceOf(await ring.getAddress())).to.equal(0n);
      expect((await ring.getModel(1)).minted).to.equal(2);
    });

    it("mintPairTo leaves one ring with each of you", async () => {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      await ring.connect(alice).mintPairTo(bob.address, 1, 14, 18, "us", NO_REF);

      expect(await ring.ownerOf(1)).to.equal(alice.address);
      expect(await ring.ownerOf(2)).to.equal(bob.address);
      expect(await ring.pairedWith(1)).to.equal(2);

      await expect(
        ring.connect(alice).mintPairTo(ethers.ZeroAddress, 1, 14, 18, "", NO_REF)
      ).to.be.revertedWithCustomError(ring, "ZeroAddress");
    });

    it("a pair takes two off the edition, and half a pair is not for sale", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      // Model 0 is limited to 3.
      await ring.connect(alice).mintPair(0, 14, 16, "", NO_REF);
      expect((await ring.getModel(0)).minted).to.equal(2);

      // One left, so a second pair cannot happen, but a single ring still can.
      await expect(ring.connect(alice).mintPair(0, 14, 16, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "SoldOut"
      );
      await ring.connect(alice).mint(0, 14, "", NO_REF);
      expect((await ring.getModel(0)).minted).to.equal(3);
    });

    it("a pair obeys the same rules as a single ring", async () => {
      const { ring, owner, alice } = await loadFixture(deployFixture);

      await expect(ring.connect(alice).mintPair(1, 5, 14, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidSize"
      );
      await expect(ring.connect(alice).mintPair(1, 14, 99, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidSize"
      );
      await expect(ring.connect(alice).mintPair(1, 14, 16, 'no"', NO_REF)).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );
      await expect(ring.connect(alice).mintPair(9, 14, 16, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "ModelNotFound"
      );

      await ring.connect(owner).setPaused(true);
      await expect(ring.connect(alice).mintPair(1, 14, 16, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "ShopPaused"
      );
    });

    it("keeping one half and promising the other is the point", async () => {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      await ring.connect(alice).mintPair(1, 14, 18, "always", NO_REF);

      await ring.connect(alice).propose(2, bob.address, "marry me", (await time.latest()) + DAY, MARRIAGE, 0, "");

      // The promised half is locked; the one she keeps is untouched.
      await expect(
        ring.connect(alice).transferFrom(alice.address, bob.address, 2)
      ).to.be.revertedWithCustomError(ring, "RingIsPromised");
      expect(await ring.ownerOf(1)).to.equal(alice.address);

      await ring.connect(bob).accept(2, "");
      expect(await ring.ownerOf(1)).to.equal(alice.address);
      expect(await ring.ownerOf(2)).to.equal(bob.address);
      // Two wallets, and each ring still knows about the other.
      expect(await ring.pairedWith(1)).to.equal(2);
      expect(await ring.pairedWith(2)).to.equal(1);
    });

    it("is paused and unpaused by the owner only", async () => {
      const { ring, owner, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).setPaused(true)).to.be.revertedWithCustomError(
        ring,
        "OwnableUnauthorizedAccount"
      );

      await expect(ring.connect(owner).setPaused(true)).to.emit(ring, "PausedSet").withArgs(true);
      expect(await ring.paused()).to.equal(true);
      await expect(ring.connect(alice).mint(0, 15, "", NO_REF)).to.be.revertedWithCustomError(
        ring,
        "ShopPaused"
      );

      await ring.connect(owner).setPaused(false);
      await ring.connect(alice).mint(0, 15, "", NO_REF);
      expect(await ring.ownerOf(1)).to.equal(alice.address);
    });

    it("pausing sales never freezes a promise already made", async () => {
      const { ring, owner, alice, bob } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 15, "", NO_REF);
      await ring.connect(alice).propose(1, bob.address, "still on", (await time.latest()) + DAY, MARRIAGE, 0, "");

      await ring.connect(owner).setPaused(true);
      await ring.connect(bob).accept(1, "");
      expect(await ring.ownerOf(1)).to.equal(bob.address);
    });
  });

  describe("inscription charset", () => {
    /**
     * ethers always encodes a JS string as well-formed UTF-8, so the only way
     * to feed the contract a malformed sequence is to lay out the calldata by
     * hand: selector, then modelId, size, the offset to the string and the
     * referrer (four head words), then the string's length and its raw bytes.
     */
    function mintCalldata(selector: string, modelId: number, size: number, raw: string) {
      const bytes = raw.startsWith("0x") ? raw.slice(2) : raw;
      const word = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32).slice(2);
      return (
        selector +
        word(modelId) +
        word(size) +
        word(0x80) +
        word(0) +
        word(bytes.length / 2) +
        bytes.padEnd(64, "0")
      );
    }

    it("accepts any language, including Cyrillic and emoji", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 15, "Аня + Дима 14.02.2026", NO_REF);
      await ring.connect(alice).mint(1, 14, "für immer, mon amour 💍", NO_REF);

      const first = await readInscription(ring, 1);
      const second = await readInscription(ring, 2);
      expect(first).to.equal("Аня + Дима 14.02.2026");
      expect(second).to.equal("für immer, mon amour 💍");
    });

    it("counts codepoints, not bytes, so the limit means the same in every language", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      // 64 Cyrillic characters is 128 bytes and must still fit.
      await ring.connect(alice).mint(0, 15, "я".repeat(64), NO_REF);
      expect(await readInscription(ring, 1)).to.have.lengthOf(64);

      await expect(
        ring.connect(alice).mint(0, 15, "я".repeat(65), NO_REF)
      ).to.be.revertedWithCustomError(ring, "TextTooLong");

      // One emoji is one character here, the way the website counts it too.
      await ring.connect(alice).mint(0, 15, "💍".repeat(64), NO_REF);
      await expect(
        ring.connect(alice).mint(1, 15, "💍".repeat(65), NO_REF)
      ).to.be.revertedWithCustomError(ring, "TextTooLong");
    });

    it("rejects malformed UTF-8 so the stored metadata always decodes", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      const selector = ring.interface.getFunction("mint")!.selector;
      const to = await ring.getAddress();

      const malformed = {
        "lone continuation byte": "0x80",
        "truncated two-byte sequence": "0xd0",
        "bad continuation byte": "0xd041",
        "overlong encoding of '/'": "0xc0af",
        "UTF-16 surrogate half": "0xeda080",
        "codepoint beyond U+10FFFF": "0xf4908080",
      };

      for (const [name, raw] of Object.entries(malformed)) {
        await expect(
          alice.sendTransaction({ to, data: mintCalldata(selector, 0, 15, raw) }),
          name
        ).to.be.revertedWithCustomError(ring, "InvalidCharacter");
      }
    });

    it("keeps tokenURI parseable when the inscription is not ASCII", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 15, "навсегда 💍", NO_REF);
      const uri = await ring.tokenURI(1);
      const json = JSON.parse(
        Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
      );
      const traits = Object.fromEntries(
        json.attributes.map((a: { trait_type: string; value: unknown }) => [a.trait_type, a.value])
      );
      expect(traits["Inscription"]).to.equal("навсегда 💍");
    });
  });

  describe("sizes", () => {
    it("converts US half-steps to ISO circumference", async () => {
      const { metadata } = await loadFixture(deployFixture);
      expect(await metadata.circumferenceTenths(6)).to.equal(442n); // US 3.0
      expect(await metadata.circumferenceTenths(14)).to.equal(544n); // US 7.0 => EU 54
      expect(await metadata.circumferenceTenths(19)).to.equal(608n); // US 9.5
      expect(await metadata.circumferenceTenths(27)).to.equal(710n); // US 13.5
    });
  });

  describe("metadata contract", () => {
    it("is fixed at deployment: JoyRings cannot be pointed anywhere else", async () => {
      const { ring, metadata } = await loadFixture(deployFixture);
      expect(await ring.metadata()).to.equal(await metadata.getAddress());
      // No setter exists, so the ABI simply has nothing to call.
      expect(ring.interface.hasFunction("setMetadata")).to.equal(false);
    });

    it("starts with the launch vocabulary, wood and bronze included", async () => {
      const { ring } = await loadFixture(deployFixture);
      expect(await ring.materials(0)).to.equal("Gold");
      expect(await ring.materials(10)).to.equal("White Gold");
      expect(await ring.materials(11)).to.equal("Wood");
      expect(await ring.materials(12)).to.equal("Bronze");
      expect(await ring.gems(5)).to.equal("Amethyst");
      await expect(ring.materials(13)).to.be.reverted;
      await expect(ring.gems(6)).to.be.reverted;
    });

    it("grows after deployment, append-only, owner-only", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).addMaterial("Leather")).to.be.revertedWithCustomError(
        ring,
        "OwnableUnauthorizedAccount"
      );
      await expect(ring.addMaterial('Le"ather')).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );

      await expect(ring.addMaterial("Leather")).to.emit(ring, "MaterialAdded").withArgs(13, "Leather");
      await expect(ring.addGem("Pearl")).to.emit(ring, "GemAdded").withArgs(6, "Pearl");

      // A model can use the new words the moment they exist.
      await ring.addModel("Saddle", 13, 6, USDC(5), 0, "ipfs://saddle", "");
      await ring.connect(alice).mint(2, 14, "", NO_REF);
      const json = JSON.parse(
        Buffer.from(
          (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
          "base64"
        ).toString("utf8")
      );
      const traits = Object.fromEntries(
        json.attributes.map((a: { trait_type: string; value: unknown }) => [a.trait_type, a.value])
      );
      expect(traits["Material"]).to.equal("Leather");
      expect(traits["Gem"]).to.equal("Pearl");
    });

    it("says 'An' before a vowel, so the vocabulary can grow past consonants", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.addMaterial("Amber");
      await ring.addModel("Resin", 13, 0, USDC(5), 0, "ipfs://amber", "");
      await ring.addModel("Log", 11, 0, USDC(5), 0, "ipfs://wood", "");
      await ring.connect(alice).mint(2, 14, "", NO_REF);
      await ring.connect(alice).mint(3, 14, "", NO_REF);
      const read = async (id: number) =>
        JSON.parse(
          Buffer.from(
            (await ring.tokenURI(id)).replace("data:application/json;base64,", ""),
            "base64"
          ).toString("utf8")
        ).description as string;
      expect(await read(1)).to.match(/^An Amber ring/);
      expect(await read(2)).to.match(/^A Wood ring/);
    });

    it("refuses a zero address for USDC or the metadata contract", async () => {
      const { owner, usdc, metadata } = await loadFixture(deployFixture);
      const JoyRings = await ethers.getContractFactory("JoyRings");
      await expect(
        JoyRings.deploy(owner.address, await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(JoyRings, "ZeroAddress");
      await expect(
        JoyRings.deploy(owner.address, ethers.ZeroAddress, await metadata.getAddress())
      ).to.be.revertedWithCustomError(JoyRings, "ZeroAddress");
    });
  });

  describe("tokenURI", () => {
    async function readMetadata(ring: { tokenURI: (id: number) => Promise<string> }, id: number) {
      const uri = await ring.tokenURI(id);
      expect(uri).to.match(/^data:application\/json;base64,/);
      return JSON.parse(
        Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString()
      );
    }

    it("returns valid on-chain JSON with size, inscription and artwork", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 15, "A+J forever", NO_REF);
      const json = await readMetadata(ring, 1);

      expect(json.name).to.equal("Solitaire #1");
      expect(json.image).to.equal("ipfs://model0");
      expect(json.animation_url).to.equal(undefined);

      const traits = Object.fromEntries(
        json.attributes.map((a: { trait_type: string; value: unknown }) => [a.trait_type, a.value])
      );
      expect(traits["Material"]).to.equal("Gold");
      expect(traits["Gem"]).to.equal("Diamond");
      expect(traits["Size (US)"]).to.equal("7.5");
      expect(traits["Size (EU)"]).to.equal("56");
      expect(traits["Inner circumference (mm)"]).to.equal("55.7");
      expect(traits["Inscription"]).to.equal("A+J forever");
    });

    it("includes animation_url when the model has one", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(1, 14, "", NO_REF);
      const json = await readMetadata(ring, 1);
      expect(json.animation_url).to.equal("ipfs://anim1");
    });

    it("names the other half of a pair, and says nothing for a single ring", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mintPair(1, 14, 18, "", NO_REF);
      await ring.connect(alice).mint(1, 14, "", NO_REF);

      const paired = await readMetadata(ring, 1);
      const traits = Object.fromEntries(
        paired.attributes.map((a: { trait_type: string; value: unknown }) => [a.trait_type, a.value])
      );
      expect(traits["Paired with"]).to.equal("#2");

      const alone = await readMetadata(ring, 3);
      const traitTypes = alone.attributes.map((a: { trait_type: string }) => a.trait_type);
      expect(traitTypes).to.not.include("Paired with");
    });

    it("omits inscription attribute when empty and formats whole sizes", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(1, 14, "", NO_REF);
      const json = await readMetadata(ring, 1);
      const traitTypes = json.attributes.map((a: { trait_type: string }) => a.trait_type);
      expect(traitTypes).to.not.include("Inscription");
      const size = json.attributes.find((a: { trait_type: string }) => a.trait_type === "Size (US)");
      expect(size.value).to.equal("7");
    });

    it("gains an Accepted date once a proposal is accepted", async () => {
      const { ring, alice, bob } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 14, "", NO_REF);
      await ring.connect(alice).propose(1, bob.address, "Marry me", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(bob).accept(1, "");
      const json = await readMetadata(ring, 1);
      const accepted = json.attributes.find(
        (a: { trait_type: string }) => a.trait_type === "Accepted"
      );
      expect(accepted).to.not.equal(undefined);
      expect(accepted.display_type).to.equal("date");
    });
  });

  describe("proposal flow", () => {
    async function mintedFixture() {
      const ctx = await deployFixture();
      await ctx.ring.connect(ctx.alice).mint(0, 15, "A+B", NO_REF);
      return ctx; // tokenId 1 owned by alice
    }

    it("propose locks the ring against transfers", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      const deadline = (await time.latest()) + 7 * DAY;
      await expect(ring.connect(alice).propose(1, bob.address, "Will you?", deadline, MARRIAGE, 0, ""))
        .to.emit(ring, "Proposed")
        .withArgs(1, alice.address, bob.address, deadline);

      await expect(
        ring.connect(alice).transferFrom(alice.address, carol.address, 1)
      ).to.be.revertedWithCustomError(ring, "RingIsPromised");
    });

    it("only the token owner can propose, not to self, future deadline", async () => {
      const { ring, alice, bob } = await loadFixture(mintedFixture);
      const deadline = (await time.latest()) + DAY;
      await expect(
        ring.connect(bob).propose(1, bob.address, "", deadline, MARRIAGE, 0, "")
      ).to.be.revertedWithCustomError(ring, "NotRingOwner");
      await expect(
        ring.connect(alice).propose(1, alice.address, "", deadline, MARRIAGE, 0, "")
      ).to.be.revertedWithCustomError(ring, "CannotProposeToSelf");
      await expect(
        ring.connect(alice).propose(1, bob.address, "", (await time.latest()) - 1, MARRIAGE, 0, "")
      ).to.be.revertedWithCustomError(ring, "InvalidDeadline");
    });

    it("recipient accepts, receives the ring, and Union No. 1 is recorded", async () => {
      const { ring, alice, bob } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "Say yes", (await time.latest()) + DAY, MARRIAGE, 0, "");
      const tx = ring.connect(bob).accept(1, "");
      await expect(tx)
        .to.emit(ring, "ProposalAccepted")
        .withArgs(1, alice.address, bob.address, 1, anyValue);
      await expect(tx).to.emit(ring, "MetadataUpdate").withArgs(1);

      expect(await ring.ownerOf(1)).to.equal(bob.address);
      expect((await proposalOf(ring, 1)).to).to.equal(ethers.ZeroAddress);
      expect(await ring.unionCount()).to.equal(1);
      expect(await ring.lastUnionOf(1)).to.equal(1);

      const union = await ring.getUnion(1);
      expect(union.tokenId).to.equal(1);
      expect(union.proposer).to.equal(alice.address);
      expect(union.recipient).to.equal(bob.address);
      expect(union.message).to.equal("Say yes");
      expect(union.acceptedAt).to.be.greaterThan(0n);
    });

    it("declining leaves no Union behind", async () => {
      const { ring, alice, bob } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "Say yes", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(bob).decline(1);
      expect(await ring.unionCount()).to.equal(0);
      expect(await ring.lastUnionOf(1)).to.equal(0);
      expect((await ring.getUnion(1)).acceptedAt).to.equal(0n);
    });

    it("only recipient can accept or decline; accept fails after deadline", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await expect(ring.connect(carol).accept(1, "")).to.be.revertedWithCustomError(
        ring,
        "NotProposalRecipient"
      );
      await expect(ring.connect(carol).decline(1)).to.be.revertedWithCustomError(
        ring,
        "NotProposalRecipient"
      );
      await time.increase(2 * DAY);
      await expect(ring.connect(bob).accept(1, "")).to.be.revertedWithCustomError(
        ring,
        "ProposalExpired"
      );
    });

    it("declining is only possible while the question stands", async () => {
      const { ring, alice, bob } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await time.increase(2 * DAY);
      await expect(ring.connect(bob).decline(1)).to.be.revertedWithCustomError(
        ring,
        "ProposalExpired"
      );
    });

    it("decline unlocks the ring for the sender", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(bob).decline(1);
      expect(await ring.ownerOf(1)).to.equal(alice.address);
      await ring.connect(alice).transferFrom(alice.address, carol.address, 1);
      expect(await ring.ownerOf(1)).to.equal(carol.address);
    });

    it("sender can cancel / reclaim after expiry", async () => {
      const { ring, alice, bob } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await time.increase(2 * DAY);
      await expect(ring.connect(bob).cancelProposal(1)).to.be.revertedWithCustomError(
        ring,
        "NotRingOwner"
      );
      await ring.connect(alice).cancelProposal(1);
      expect((await proposalOf(ring, 1)).to).to.equal(ethers.ZeroAddress);
    });

    it("a promised ring cannot be promised again", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await expect(
        ring.connect(alice).propose(1, carol.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "")
      ).to.be.revertedWithCustomError(ring, "RingIsPromised");
    });

    it("the lock lifts by itself when the deadline passes", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await expect(
        ring.connect(alice).transferFrom(alice.address, carol.address, 1)
      ).to.be.revertedWithCustomError(ring, "RingIsPromised");

      await time.increase(2 * DAY);

      // No cancelProposal in between: silence must never cost the owner the ring.
      await ring.connect(alice).transferFrom(alice.address, carol.address, 1);
      expect(await ring.ownerOf(1)).to.equal(carol.address);
      await expect(ring.connect(bob).accept(1, "")).to.be.revertedWithCustomError(
        ring,
        "ProposalExpired"
      );
    });

    it("an expired promise can simply be replaced by a new one", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "ask one", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await time.increase(2 * DAY);

      await ring.connect(alice).propose(1, carol.address, "ask two", (await time.latest()) + DAY, MARRIAGE, 0, "");
      const p = await proposalOf(ring, 1);
      expect(p.to).to.equal(carol.address);
      expect(p.message).to.equal("ask two");

      await ring.connect(carol).accept(1, "");
      expect(await ring.ownerOf(1)).to.equal(carol.address);
    });

    it("a new owner can clear a stale promise attached to the ring they bought", async () => {
      const { ring, alice, bob, carol } = await loadFixture(mintedFixture);
      await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await time.increase(2 * DAY);
      await ring.connect(alice).transferFrom(alice.address, carol.address, 1);

      await ring.connect(carol).cancelProposal(1);
      expect((await proposalOf(ring, 1)).to).to.equal(ethers.ZeroAddress);
    });

    it("accepting refuses to strand the ring in a wallet that cannot hold it", async () => {
      const { ring, alice } = await loadFixture(mintedFixture);
      const MockWallet = await ethers.getContractFactory("MockWallet");
      const ringAddress = await ring.getAddress();

      const broken = await MockWallet.deploy(false);
      await ring
        .connect(alice)
        .propose(1, await broken.getAddress(), "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await expect(broken.acceptRing(ringAddress, 1)).to.be.revertedWithCustomError(
        ring,
        "ERC721InvalidReceiver"
      );
      expect(await ring.ownerOf(1)).to.equal(alice.address);

      const working = await MockWallet.deploy(true);
      await ring.connect(alice).cancelProposal(1);
      await ring
        .connect(alice)
        .propose(1, await working.getAddress(), "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await working.acceptRing(ringAddress, 1);
      expect(await ring.ownerOf(1)).to.equal(await working.getAddress());
    });
  });

  describe("referrals", () => {
    it("a referred mint thanks the referrer with 10%, and the buyer pays the same", async () => {
      const { ring, usdc, owner, alice, dave } = await loadFixture(deployFixture);
      // Model 1 costs 9 USDC.
      await expect(ring.connect(alice).mint(1, 14, "", dave.address))
        .to.emit(ring, "ReferralPaid")
        .withArgs(dave.address, 1, USDC(0.9));

      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(1000 - 9));
      expect(await usdc.balanceOf(dave.address)).to.equal(USDC(0.9));
      expect(await usdc.balanceOf(owner.address)).to.equal(USDC(8.1));
      expect(await usdc.balanceOf(await ring.getAddress())).to.equal(0n);
    });

    it("referring yourself pays nobody, and no one is thanked", async () => {
      const { ring, usdc, owner, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).mint(1, 14, "", alice.address)).to.not.emit(
        ring,
        "ReferralPaid"
      );
      expect(await usdc.balanceOf(owner.address)).to.equal(USDC(9));
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(1000 - 9));
    });

    it("a pair thanks the referrer once, on the pair price", async () => {
      const { ring, usdc, owner, alice, dave } = await loadFixture(deployFixture);
      // Two 9 USDC rings less 10% is 16.2; the thank-you is 10% of that.
      await expect(ring.connect(alice).mintPair(1, 14, 18, "", dave.address))
        .to.emit(ring, "ReferralPaid")
        .withArgs(dave.address, 1, USDC(1.62));
      expect(await usdc.balanceOf(dave.address)).to.equal(USDC(1.62));
      expect(await usdc.balanceOf(owner.address)).to.equal(USDC(14.58));
    });

    it("gifts pay the thank-you too", async () => {
      const { ring, usdc, alice, bob, dave } = await loadFixture(deployFixture);
      await ring.connect(alice).mintTo(bob.address, 1, 14, "", dave.address);
      await ring.connect(alice).mintPairTo(bob.address, 1, 14, 16, "", dave.address);
      expect(await usdc.balanceOf(dave.address)).to.equal(USDC(0.9 + 1.62));
    });
  });

  describe("proposals by link", () => {
    /** What the link's key signs: this contract, chain, ring, deadline and who says yes. */
    async function linkSignature(
      key: { signMessage: (m: Uint8Array) => Promise<string> },
      ringAddress: string,
      tokenId: number,
      deadline: number | bigint,
      acceptor: string
    ) {
      const { chainId } = await ethers.provider.getNetwork();
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "address", "uint256", "uint64", "address"],
          [chainId, ringAddress, tokenId, deadline, acceptor]
        )
      );
      return key.signMessage(ethers.getBytes(hash));
    }

    async function linkFixture() {
      const ctx = await deployFixture();
      const key = ethers.Wallet.createRandom();
      const deadline = (await time.latest()) + 7 * DAY;
      await ctx.ring.connect(ctx.alice).mint(0, 15, "A+B", NO_REF);
      await ctx.ring.connect(ctx.alice).proposeByLink(1, key.address, "Will you?", deadline, MARRIAGE, 0, "");
      return { ...ctx, key, deadline, ringAddress: await ctx.ring.getAddress() };
    }

    it("locks the ring and records that the question travels by link", async () => {
      const { ring, alice, carol, key } = await loadFixture(linkFixture);
      const [proposal] = await ring.getProposalState(1);
      expect(proposal.byLink).to.equal(true);
      expect(proposal.to).to.equal(key.address);
      await expect(
        ring.connect(alice).transferFrom(alice.address, carol.address, 1)
      ).to.be.revertedWithCustomError(ring, "RingIsPromised");
    });

    it("whoever holds the link says yes into their own wallet", async () => {
      const { ring, alice, bob, key, deadline, ringAddress } = await loadFixture(linkFixture);
      const signature = await linkSignature(key, ringAddress, 1, deadline, bob.address);

      await expect(ring.connect(bob).acceptByLink(1, signature, ""))
        .to.emit(ring, "ProposalAccepted")
        .withArgs(1, alice.address, bob.address, 1, anyValue);

      expect(await ring.ownerOf(1)).to.equal(bob.address);
      const union = await ring.getUnion(1);
      expect(union.recipient).to.equal(bob.address);
      expect(union.message).to.equal("Will you?");
      expect((await proposalOf(ring, 1)).to).to.equal(ethers.ZeroAddress);
    });

    it("a signature lifted from the mempool is useless to anyone else", async () => {
      const { ring, bob, carol, key, deadline, ringAddress } = await loadFixture(linkFixture);
      const forBob = await linkSignature(key, ringAddress, 1, deadline, bob.address);
      await expect(ring.connect(carol).acceptByLink(1, forBob, "")).to.be.revertedWithCustomError(
        ring,
        "NotProposalRecipient"
      );
    });

    it("the key itself can never take the ring, even with gas", async () => {
      const { ring, owner, key } = await loadFixture(linkFixture);
      const funded = key.connect(ethers.provider);
      await owner.sendTransaction({ to: key.address, value: ethers.parseEther("1") });
      await expect(ring.connect(funded).accept(1, "")).to.be.revertedWithCustomError(
        ring,
        "NotProposalRecipient"
      );
    });

    it("refuses the wrong key, and the asker saying yes to themselves", async () => {
      const { ring, alice, bob, key, deadline, ringAddress } = await loadFixture(linkFixture);
      const stranger = ethers.Wallet.createRandom();
      const forged = await linkSignature(stranger, ringAddress, 1, deadline, bob.address);
      await expect(ring.connect(bob).acceptByLink(1, forged, "")).to.be.revertedWithCustomError(
        ring,
        "NotProposalRecipient"
      );

      const own = await linkSignature(key, ringAddress, 1, deadline, alice.address);
      await expect(ring.connect(alice).acceptByLink(1, own, "")).to.be.revertedWithCustomError(
        ring,
        "CannotProposeToSelf"
      );
    });

    it("an expired link cannot be accepted, and the ring unlocks on time", async () => {
      const { ring, alice, bob, carol, key, deadline, ringAddress } = await loadFixture(linkFixture);
      const signature = await linkSignature(key, ringAddress, 1, deadline, bob.address);
      await time.increase(8 * DAY);
      await expect(ring.connect(bob).acceptByLink(1, signature, "")).to.be.revertedWithCustomError(
        ring,
        "ProposalExpired"
      );
      await ring.connect(alice).transferFrom(alice.address, carol.address, 1);
    });

    it("a signature belongs to one question: re-asking with the same key voids it", async () => {
      const { ring, alice, bob, key, deadline, ringAddress } = await loadFixture(linkFixture);
      const old = await linkSignature(key, ringAddress, 1, deadline, bob.address);
      await ring.connect(alice).cancelProposal(1);
      await ring.connect(alice).proposeByLink(1, key.address, "Again?", deadline + DAY, MARRIAGE, 0, "");
      await expect(ring.connect(bob).acceptByLink(1, old, "")).to.be.revertedWithCustomError(
        ring,
        "NotProposalRecipient"
      );
    });

    it("the two kinds of proposal do not answer for each other", async () => {
      const { ring, alice, bob, ringAddress } = await loadFixture(deployFixture).then(async (c) => ({
        ...c,
        ringAddress: await c.ring.getAddress(),
      }));
      await ring.connect(alice).mint(0, 15, "", NO_REF);
      const deadline = (await time.latest()) + DAY;
      await ring.connect(alice).propose(1, bob.address, "", deadline, MARRIAGE, 0, "");
      const key = ethers.Wallet.createRandom();
      const signature = await linkSignature(key, ringAddress, 1, deadline, bob.address);
      await expect(ring.connect(bob).acceptByLink(1, signature, "")).to.be.revertedWithCustomError(
        ring,
        "NoActiveProposal"
      );
      expect((await proposalOf(ring, 1)).byLink).to.equal(false);
    });
  });

  describe("unions", () => {
    async function acceptedFixture() {
      const ctx = await deployFixture();
      const { ring, alice, bob } = ctx;
      await ring.connect(alice).mint(0, 15, "A+B", NO_REF);
      await ring.connect(alice).propose(1, bob.address, "first", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(bob).accept(1, "");
      return ctx; // ring 1 now with bob, Union No. 1 = alice -> bob
    }

    it("a second yes with the same ring adds a union and never rewrites the first", async () => {
      const { ring, bob, carol, alice } = await loadFixture(acceptedFixture);
      const first = await ring.getUnion(1);

      // Bob, now holding the ring, asks someone else with it.
      await ring.connect(bob).propose(1, carol.address, "second", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(carol).accept(1, "");

      expect(await ring.unionCount()).to.equal(2);
      expect(await ring.lastUnionOf(1)).to.equal(2);

      // The certificate somebody already framed and shared still says what it said.
      const again = await ring.getUnion(1);
      expect(again.proposer).to.equal(alice.address);
      expect(again.recipient).to.equal(bob.address);
      expect(again.message).to.equal("first");
      expect(again.acceptedAt).to.equal(first.acceptedAt);

      const second = await ring.getUnion(2);
      expect(second.tokenId).to.equal(1);
      expect(second.proposer).to.equal(bob.address);
      expect(second.recipient).to.equal(carol.address);
      expect(second.message).to.equal("second");
    });

    it("numbers unions across rings in the order the yeses happened", async () => {
      const { ring, alice, bob, carol } = await loadFixture(acceptedFixture);
      await ring.connect(carol).mint(1, 14, "", NO_REF);
      await ring.connect(carol).propose(2, alice.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(alice).accept(2, "");

      expect(await ring.lastUnionOf(1)).to.equal(1);
      expect(await ring.lastUnionOf(2)).to.equal(2);
      expect((await ring.getUnion(2)).tokenId).to.equal(2);
      expect((await ring.getUnion(1)).recipient).to.equal(bob.address);
    });

    it("keeps each wallet's certificates findable after the rings are sold", async () => {
      const { ring, alice, bob, carol, dave } = await loadFixture(acceptedFixture);
      // Alice asks Carol with a second ring, then Bob sells ring 1 to Dave.
      await ring.connect(alice).mint(0, 15, "", NO_REF);
      await ring.connect(alice).propose(2, carol.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(carol).accept(2, "");
      await ring.connect(bob).transferFrom(bob.address, dave.address, 1);

      expect(await ring.unionsOf(alice.address)).to.deep.equal([1n, 2n]);
      expect(await ring.unionsOf(bob.address)).to.deep.equal([1n]);
      expect(await ring.unionsOf(carol.address)).to.deep.equal([2n]);
      // Holding the ring does not put Dave on anyone's certificate.
      expect(await ring.unionsOf(dave.address)).to.deep.equal([]);
    });

    describe("occasions", () => {
      const COFOUNDERS = 4;

      it("a proposal carries its occasion into the union and the ring's metadata", async () => {
        const { ring, alice, bob } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        await ring
          .connect(alice)
          .propose(1, bob.address, "Co-found with me?", (await time.latest()) + DAY, COFOUNDERS, 0, "");
        expect((await proposalOf(ring, 1)).occasion).to.equal(COFOUNDERS);

        await ring.connect(bob).accept(1, "");
        expect((await ring.getUnion(1)).occasion).to.equal(COFOUNDERS);

        const json = JSON.parse(
          Buffer.from(
            (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
            "base64"
          ).toString("utf8")
        );
        const occasion = json.attributes.find(
          (a: { trait_type: string }) => a.trait_type === "Occasion"
        );
        expect(occasion.value).to.equal("Co-founders");
      });

      it("link proposals carry it too", async () => {
        const { ring, alice } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        const key = ethers.Wallet.createRandom();
        await ring
          .connect(alice)
          .proposeByLink(1, key.address, "", (await time.latest()) + DAY, 3, 0, "");
        expect((await proposalOf(ring, 1)).occasion).to.equal(3);
      });

      it("carries the asker's room and yes label, and the answerer's reply", async () => {
        const { ring, alice, bob } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        await ring
          .connect(alice)
          .propose(1, bob.address, "Move in with me?", (await time.latest()) + DAY, 5, 7, "Hand me the keys");

        const p = await proposalOf(ring, 1);
        expect(p.occasion).to.equal(5);
        expect(p.theme).to.equal(7);
        expect(p.yesLabel).to.equal("Hand me the keys");

        await ring.connect(bob).accept(1, "Took you long enough 🔑");
        const union = await ring.getUnion(1);
        expect(union.theme).to.equal(7);
        expect(union.message).to.equal("Move in with me?");
        expect(union.reply).to.equal("Took you long enough 🔑");
      });

      it("keeps labels and replies short and JSON-safe", async () => {
        const { ring, alice, bob } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        const deadline = (await time.latest()) + DAY;
        await expect(
          ring.connect(alice).propose(1, bob.address, "", deadline, 0, 0, "x".repeat(25))
        ).to.be.revertedWithCustomError(ring, "TextTooLong");
        await expect(
          ring.connect(alice).propose(1, bob.address, "", deadline, 0, 0, 'say "yes"')
        ).to.be.revertedWithCustomError(ring, "InvalidCharacter");

        await ring.connect(alice).propose(1, bob.address, "", deadline, 0, 0, "");
        await expect(ring.connect(bob).accept(1, "y".repeat(141))).to.be.revertedWithCustomError(
          ring,
          "TextTooLong"
        );
        await expect(ring.connect(bob).accept(1, "no\\")).to.be.revertedWithCustomError(
          ring,
          "InvalidCharacter"
        );
        await ring.connect(bob).accept(1, "");
        expect((await ring.getUnion(1)).reply).to.equal("");
      });

      it("a reply by link is the answerer's own, not part of what the key signs", async () => {
        const { ring, alice, bob } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        const key = ethers.Wallet.createRandom();
        const deadline = (await time.latest()) + DAY;
        await ring.connect(alice).proposeByLink(1, key.address, "", deadline, 1, 1, "Be mine");
        const { chainId } = await ethers.provider.getNetwork();
        const hash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "address", "uint256", "uint64", "address"],
            [chainId, await ring.getAddress(), 1, deadline, bob.address]
          )
        );
        const signature = await key.signMessage(ethers.getBytes(hash));
        await ring.connect(bob).acceptByLink(1, signature, "Always.");
        expect((await ring.getUnion(1)).reply).to.equal("Always.");
      });

      it("stores occasions the metadata does not know, and leaves the trait out", async () => {
        const { ring, metadata, alice, bob } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        await ring.connect(alice).propose(1, bob.address, "", (await time.latest()) + DAY, 42, 0, "");
        await ring.connect(bob).accept(1, "");
        expect((await ring.getUnion(1)).occasion).to.equal(42);
        expect(await metadata.occasion(42)).to.equal("");

        const json = JSON.parse(
          Buffer.from(
            (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
            "base64"
          ).toString("utf8")
        );
        const types = json.attributes.map((a: { trait_type: string }) => a.trait_type);
        expect(types).to.not.include("Occasion");
      });

      it("a ring never asked about has no Occasion trait", async () => {
        const { ring, alice } = await loadFixture(deployFixture);
        await ring.connect(alice).mint(0, 15, "", NO_REF);
        const json = JSON.parse(
          Buffer.from(
            (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
            "base64"
          ).toString("utf8")
        );
        const types = json.attributes.map((a: { trait_type: string }) => a.trait_type);
        expect(types).to.not.include("Occasion");
      });
    });

    describe("witnesses", () => {
      it("anyone else can sign once, with a wish, and the ring's metadata counts them", async () => {
        const { ring, carol, dave } = await loadFixture(acceptedFixture);
        await expect(ring.connect(carol).witness(1, "Finally! 🎉"))
          .to.emit(ring, "Witnessed")
          .withArgs(1, carol.address, 0, "Finally! 🎉")
          .and.to.emit(ring, "MetadataUpdate")
          .withArgs(1);
        await ring.connect(dave).witness(1, "");

        expect(await ring.witnessCount(1)).to.equal(2);
        expect(await ring.hasWitnessed(1, carol.address)).to.equal(true);
        const first = await ring.witnessAt(1, 0);
        expect(first.wallet).to.equal(carol.address);
        expect(first.note).to.equal("Finally! 🎉");
        expect(first.signedAt).to.be.greaterThan(0n);
        expect((await ring.witnessAt(1, 1)).wallet).to.equal(dave.address);

        const json = JSON.parse(
          Buffer.from(
            (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
            "base64"
          ).toString("utf8")
        );
        const witnesses = json.attributes.find(
          (a: { trait_type: string }) => a.trait_type === "Witnesses"
        );
        expect(witnesses.value).to.equal(2);
        expect(witnesses.display_type).to.equal("number");
      });

      it("one signature per wallet, and never from the couple themselves", async () => {
        const { ring, alice, bob, carol } = await loadFixture(acceptedFixture);
        await ring.connect(carol).witness(1, "");
        await expect(ring.connect(carol).witness(1, "again")).to.be.revertedWithCustomError(
          ring,
          "AlreadyWitnessed"
        );
        for (const party of [alice, bob]) {
          await expect(ring.connect(party).witness(1, "")).to.be.revertedWithCustomError(
            ring,
            "CannotWitnessOwnUnion"
          );
        }
      });

      it("refuses a union that does not exist and a note that would break", async () => {
        const { ring, carol } = await loadFixture(acceptedFixture);
        await expect(ring.connect(carol).witness(2, "")).to.be.revertedWithCustomError(
          ring,
          "NoSuchUnion"
        );
        await expect(ring.connect(carol).witness(1, 'a "quote"')).to.be.revertedWithCustomError(
          ring,
          "InvalidCharacter"
        );
        await expect(
          ring.connect(carol).witness(1, "x".repeat(141))
        ).to.be.revertedWithCustomError(ring, "TextTooLong");
      });

      it("either of the couple can hide a note, nobody else, and it still counts", async () => {
        const { ring, bob, carol, dave } = await loadFixture(acceptedFixture);
        await ring.connect(carol).witness(1, "something unkind");
        await expect(ring.connect(dave).hideWitness(1, 0)).to.be.revertedWithCustomError(
          ring,
          "NotPartOfUnion"
        );
        await expect(ring.connect(bob).hideWitness(1, 0))
          .to.emit(ring, "WitnessHidden")
          .withArgs(1, 0);

        const hidden = await ring.witnessAt(1, 0);
        expect(hidden.hidden).to.equal(true);
        expect(hidden.note).to.equal("");
        expect(hidden.wallet).to.equal(carol.address);
        expect(await ring.witnessCount(1)).to.equal(1);
      });

      it("a witness of an older union does not touch the ring's current metadata", async () => {
        const { ring, bob, carol, dave } = await loadFixture(acceptedFixture);
        await ring.connect(bob).propose(1, carol.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
        await ring.connect(carol).accept(1, ""); // union 2 is now the ring's latest
        await expect(ring.connect(dave).witness(1, "for the first one")).to.not.emit(
          ring,
          "MetadataUpdate"
        );
        expect(await ring.witnessCount(1)).to.equal(1);
        expect(await ring.witnessCount(2)).to.equal(0);
      });
    });

    it("getProposalState reads the question and the last union together", async () => {
      const { ring, bob, carol } = await loadFixture(acceptedFixture);
      await ring.connect(bob).propose(1, carol.address, "again?", (await time.latest()) + DAY, MARRIAGE, 0, "");

      let [proposal, unionId] = await ring.getProposalState(1);
      expect(proposal.to).to.equal(carol.address);
      expect(unionId).to.equal(1);

      // A decline clears the question and leaves the union number alone,
      // which is exactly how the page tells a no from a yes.
      await ring.connect(carol).decline(1);
      [proposal, unionId] = await ring.getProposalState(1);
      expect(proposal.to).to.equal(ethers.ZeroAddress);
      expect(unionId).to.equal(1);
    });

    it("tokenURI's Accepted date follows the ring's latest union", async () => {
      const { ring, bob, carol } = await loadFixture(acceptedFixture);
      await time.increase(30 * DAY);
      await ring.connect(bob).propose(1, carol.address, "", (await time.latest()) + DAY, MARRIAGE, 0, "");
      await ring.connect(carol).accept(1, "");

      const json = JSON.parse(
        Buffer.from(
          (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
          "base64"
        ).toString("utf8")
      );
      const accepted = json.attributes.find(
        (a: { trait_type: string }) => a.trait_type === "Accepted"
      );
      expect(accepted.value).to.equal(Number((await ring.getUnion(2)).acceptedAt));
    });
  });

  describe("metadata updates (ERC-4906)", () => {
    it("advertises ERC-4906 alongside ERC-721, Enumerable and ERC-2981", async () => {
      const { ring } = await loadFixture(deployFixture);
      expect(await ring.supportsInterface("0x49064906")).to.equal(true);
      expect(await ring.supportsInterface("0x80ac58cd")).to.equal(true);
      expect(await ring.supportsInterface("0x780e9d63")).to.equal(true);
      expect(await ring.supportsInterface("0x2a55205a")).to.equal(true);
      expect(await ring.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("new artwork tells marketplaces to refresh every token", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      // Nothing minted, nothing to refresh.
      await expect(ring.setModelMedia(0, "ipfs://a", "")).to.not.emit(ring, "BatchMetadataUpdate");

      await ring.connect(alice).mintPair(1, 14, 16, "", NO_REF);
      await ring.connect(alice).mint(0, 14, "", NO_REF);
      await expect(ring.setModelMedia(0, "ipfs://b", ""))
        .to.emit(ring, "BatchMetadataUpdate")
        .withArgs(1, 3);
    });

    it("a new external_url base refreshes every token too", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 14, "", NO_REF);
      await expect(ring.setExternalBaseURI("https://joyrings.xyz/r/"))
        .to.emit(ring, "BatchMetadataUpdate")
        .withArgs(1, 1);
      await expect(ring.setExternalBaseURI('https://"/')).to.be.revertedWithCustomError(
        ring,
        "InvalidCharacter"
      );
    });
  });

  describe("ownership", () => {
    it("moves in two steps, so a typo cannot hand the shop to nobody", async () => {
      const { ring, owner, alice, bob } = await loadFixture(deployFixture);
      await ring.transferOwnership(alice.address);
      expect(await ring.owner()).to.equal(owner.address);
      expect(await ring.pendingOwner()).to.equal(alice.address);

      await expect(ring.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(
        ring,
        "OwnableUnauthorizedAccount"
      );
      await ring.connect(alice).acceptOwnership();
      expect(await ring.owner()).to.equal(alice.address);
      await expect(ring.setPaused(true)).to.be.revertedWithCustomError(
        ring,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("collection metadata", () => {
    it("contractURI is owner-only and announces its own change", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      expect(await ring.contractURI()).to.equal("");

      await expect(
        ring.connect(alice).setContractURI("ipfs://collection")
      ).to.be.revertedWithCustomError(ring, "OwnableUnauthorizedAccount");

      await expect(ring.setContractURI("ipfs://collection")).to.emit(ring, "ContractURIUpdated");
      expect(await ring.contractURI()).to.equal("ipfs://collection");
    });

    it("external_url appears only once a base URI is configured", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 15, "", NO_REF);

      const read = async () =>
        JSON.parse(
          Buffer.from(
            (await ring.tokenURI(1)).replace("data:application/json;base64,", ""),
            "base64"
          ).toString("utf8")
        );

      expect((await read()).external_url).to.equal(undefined);

      await ring.setExternalBaseURI("https://joyrings.xyz/r/");
      expect((await read()).external_url).to.equal("https://joyrings.xyz/r/1");
    });

    it("only the owner sets the external base URI", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await expect(
        ring.connect(alice).setExternalBaseURI("https://evil.example/")
      ).to.be.revertedWithCustomError(ring, "OwnableUnauthorizedAccount");
    });
  });

  describe("treasury", () => {
    it("starts as the deployer, and the owner can point it at a multisig", async () => {
      const { ring, usdc, owner, alice, bob } = await loadFixture(deployFixture);
      expect(await ring.treasury()).to.equal(owner.address);

      await expect(ring.setTreasury(bob.address)).to.emit(ring, "TreasurySet").withArgs(bob.address);
      await ring.connect(alice).mint(1, 14, "", NO_REF);
      expect(await usdc.balanceOf(bob.address)).to.equal(USDC(1000 + 9));
      expect(await usdc.balanceOf(owner.address)).to.equal(0n);
    });

    it("only the owner sets the treasury, and never to nobody", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await expect(ring.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(
        ring,
        "OwnableUnauthorizedAccount"
      );
      await expect(ring.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ring,
        "ZeroAddress"
      );
    });

    it("recovers any token sent here by mistake, USDC included", async () => {
      const { ring, usdc, owner, alice } = await loadFixture(deployFixture);
      const Other = await ethers.getContractFactory("MockUSDC");
      const other = await Other.deploy();
      const ringAddress = await ring.getAddress();

      await other.mint(ringAddress, 5_000_000n);
      await usdc.connect(alice).transfer(ringAddress, USDC(3));

      await expect(
        ring.connect(alice).rescueERC20(await other.getAddress(), alice.address, 1n)
      ).to.be.revertedWithCustomError(ring, "OwnableUnauthorizedAccount");

      await ring.rescueERC20(await other.getAddress(), owner.address, 5_000_000n);
      expect(await other.balanceOf(owner.address)).to.equal(5_000_000n);
      expect(await other.balanceOf(ringAddress)).to.equal(0n);

      // Revenue never lands here, so stray USDC is just another mistake to undo.
      await ring.rescueERC20(await usdc.getAddress(), alice.address, USDC(3));
      expect(await usdc.balanceOf(ringAddress)).to.equal(0n);
    });

    it("neither rescue can be pointed at the zero address", async () => {
      const { ring, usdc } = await loadFixture(deployFixture);
      await expect(
        ring.rescueERC20(await usdc.getAddress(), ethers.ZeroAddress, 0n)
      ).to.be.revertedWithCustomError(ring, "ZeroAddress");
      await expect(ring.rescueETH(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ring,
        "ZeroAddress"
      );
    });

    it("the vault enumerates through the standard ERC-721 Enumerable calls", async () => {
      const { ring, alice } = await loadFixture(deployFixture);
      await ring.connect(alice).mint(0, 15, "", NO_REF);
      await ring.connect(alice).mint(1, 20, "", NO_REF);
      expect(await ring.balanceOf(alice.address)).to.equal(2);
      expect(await ring.tokenOfOwnerByIndex(alice.address, 0)).to.equal(1);
      expect(await ring.tokenOfOwnerByIndex(alice.address, 1)).to.equal(2);
    });
  });
});
