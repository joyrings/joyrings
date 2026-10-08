/**
 * Client-side mirror of the on-chain catalog.
 *
 * This file is the single source of truth for the shop: the website renders
 * from it instantly, and packages/contracts/scripts/deploy.ts seeds the
 * contract from the same list so model ids always line up. Live fields
 * (minted count, active flag, current price) are read from the chain when a
 * wallet is connected.
 *
 * What lives where:
 *   - artwork (images[], animation) is website + IPFS media, per model
 *   - size and inscription are per-token attributes chosen at mint, stored
 *     on-chain, and never painted into the artwork
 */

export type MaterialKey =
  | "yellowGold"
  | "whiteGold"
  | "roseGold"
  | "silver"
  | "platinum"
  | "steel"
  | "copper"
  | "glass"
  | "plastic"
  | "rubber"
  | "cotton"
  | "wood"
  | "bronze";
export type GemKey = "none" | "diamond" | "ruby" | "sapphire" | "emerald" | "amethyst";

export interface MaterialSpec {
  /** index used by the contract */
  id: number;
  label: string;
  /** toy-3D gradient stops: light → mid → dark */
  light: string;
  mid: string;
  dark: string;
  /** inscription text color on this band */
  inscription: string;
  /**
   * Cheapest a plain band of this material may be sold for. See the pricing
   * note above RING_MODELS; deploy.ts refuses to seed a model priced below it.
   */
  floorUsdc: number;
}

export interface GemSpec {
  id: number;
  label: string;
  light: string;
  mid: string;
  dark: string;
  /** What the stone adds on top of the material floor. */
  premiumUsdc: number;
}

/**
 * The material vocabulary.
 *
 * Two orderings live here and they are not the same one. `id` is the index the
 * contract stores, so it is **append-only** — a new material takes the next
 * free number no matter where it sits in this object. The order of the keys is
 * the display order, driving the filter chips in RingBrowser, and is free to
 * change: precious metals first, then everything else roughly by worth.
 *
 * Adding one: before deployment, append it to the constructor list in
 * JoyRings.sol too; after deployment, call `addMaterial("Name")` on the
 * contract first and give the entry here the number it returns. deploy.ts
 * refuses to seed if the two lists disagree.
 *
 * Every material here is one a real object could be made of, and each one is
 * carried by artwork that actually looks like it — a ring made of neon tubing
 * is Glass, not Platinum. The list is kept as short as the catalog allows, so
 * a new material is added only when no existing one describes the picture.
 *
 * White Gold, Platinum and Silver all render as bright white metal and are
 * told apart by price rather than by pixel, exactly as they are in a real
 * jeweller's case.
 */
export const MATERIALS: Record<MaterialKey, MaterialSpec> = {
  yellowGold: { id: 0, label: "Gold", light: "#ffe08a", mid: "#f6c453", dark: "#d99a2b", inscription: "#8a5f14", floorUsdc: 9 },
  whiteGold: { id: 10, label: "White Gold", light: "#ffffff", mid: "#dfe5ed", dark: "#9aa6b6", inscription: "#4f5a6b", floorUsdc: 9 },
  roseGold: { id: 1, label: "Rose Gold", light: "#ffd8ca", mid: "#f2a48c", dark: "#d97d62", inscription: "#a04f36", floorUsdc: 8 },
  silver: { id: 2, label: "Silver", light: "#f3f6fa", mid: "#c9d2de", dark: "#93a1b3", inscription: "#5c6b7e", floorUsdc: 5 },
  platinum: { id: 3, label: "Platinum", light: "#dce4ec", mid: "#a7b4c4", dark: "#66788c", inscription: "#3f4e60", floorUsdc: 12 },
  glass: { id: 6, label: "Glass", light: "#f2fbff", mid: "#cfeaf5", dark: "#9dc6d8", inscription: "#3f6272", floorUsdc: 4 },
  bronze: { id: 12, label: "Bronze", light: "#f3d29c", mid: "#c9955a", dark: "#8f6130", inscription: "#5b3b19", floorUsdc: 2 },
  copper: { id: 5, label: "Copper", light: "#f7cfae", mid: "#d98a54", dark: "#a75c2e", inscription: "#6d3a18", floorUsdc: 2 },
  wood: { id: 11, label: "Wood", light: "#e8c29a", mid: "#b98251", dark: "#855632", inscription: "#4e3119", floorUsdc: 2 },
  cotton: { id: 9, label: "Cotton", light: "#ffffff", mid: "#e9f1f8", dark: "#c2d2e0", inscription: "#63748a", floorUsdc: 2 },
  plastic: { id: 7, label: "Plastic", light: "#ffffff", mid: "#e6e3e0", dark: "#b0aaa4", inscription: "#615b56", floorUsdc: 1 },
  steel: { id: 4, label: "Steel", light: "#eef2f6", mid: "#b6bfc9", dark: "#7b8590", inscription: "#4b545e", floorUsdc: 1 },
  rubber: { id: 8, label: "Rubber", light: "#8a929c", mid: "#585f68", dark: "#33383e", inscription: "#e6e9ed", floorUsdc: 1 },
};

export const GEMS: Record<GemKey, GemSpec> = {
  none: { id: 0, label: "None", light: "", mid: "", dark: "", premiumUsdc: 0 },
  diamond: { id: 1, label: "Diamond", light: "#eaf8ff", mid: "#bce9fa", dark: "#7fcbeb", premiumUsdc: 6 },
  ruby: { id: 2, label: "Ruby", light: "#ff9aa5", mid: "#ff4d61", dark: "#d42848", premiumUsdc: 4 },
  sapphire: { id: 3, label: "Sapphire", light: "#9ab8ff", mid: "#4d7dff", dark: "#2e55d4", premiumUsdc: 4 },
  emerald: { id: 4, label: "Emerald", light: "#8ff0c0", mid: "#2ecf8e", dark: "#17a468", premiumUsdc: 4 },
  amethyst: { id: 5, label: "Amethyst", light: "#d6bdff", mid: "#a97df5", dark: "#7e4fd4", premiumUsdc: 3 },
};

export type CollectionKey =
  | "Originals"
  | "Pop Art"
  | "Honey"
  | "Industrial"
  | "Trash Luxury"
  | "Garage Gems";

export interface Collection {
  key: CollectionKey;
  title: string;
  blurb: string;
}

/** Display order of the shop. */
export const COLLECTIONS: Collection[] = [
  {
    key: "Originals",
    title: "The Originals",
    blurb: "The rings a jeweller would recognize. Rendered as toys, priced as a snack.",
  },
  {
    key: "Pop Art",
    title: "Pop Art",
    blurb: "Loud, bright, and unbothered. For couples who do not do subtle.",
  },
  {
    key: "Honey",
    title: "Honey",
    blurb: "Rings that look edible. None of them are. We checked.",
  },
  {
    key: "Industrial",
    title: "Industrial",
    blurb:
      "Precision parts, cut in precious metal. Engineering as romance, at jeweller's prices.",
  },
  {
    key: "Garage Gems",
    title: "Garage Gems",
    blurb: "Found on a workbench, worn like a diamond. The purest form of the joke.",
  },
  {
    key: "Trash Luxury",
    title: "Trash Luxury",
    blurb: "Coming soon. Exactly what it sounds like.",
  },
];

export interface RingModel {
  id: number;
  slug: string;
  name: string;
  material: MaterialKey;
  gem: GemKey;
  /** whole USDC, e.g. 19 = 19 USDC. Mirrors priceUsdc (6 decimals) on-chain. */
  priceUsdc: number;
  /** 0 = open edition */
  maxSupply: number;
  tagline: string;
  description: string;
  collection: CollectionKey;
  /**
   * Gallery, first entry is the primary shot used on cards and as the NFT
   * image. Models with no images fall back to the generated toy-3D SVG.
   */
  images?: string[];
  /** mp4 loop, when the model has one. Shown in the gallery, minted as animation_url. */
  animation?: string;
}

/**
 * How a ring is priced.
 *
 *   price = MATERIALS[material].floorUsdc
 *         + GEMS[gem].premiumUsdc
 *         + up to 5 for the amount of work in the piece
 *         + 2 if the edition is small enough to run out
 *
 * The material floor is the load-bearing part: it is why nothing made of
 * plastic can ever cost more than a platinum band, and why two plain bands of
 * the same metal (Quiet Luxury, Mercury Ring) come out at the same number
 * without anyone having to remember to keep them in step. deploy.ts enforces
 * the floor before it seeds the contract.
 *
 * Every number here is deliberately low. The whole argument the site makes is
 * that a ring which outlives the marriage should cost less than the flowers,
 * and a catalog topping out near fifty quietly undercuts it. The ladder runs
 * 1 to 20: the cheapest materials floor at 1, because "from 1 USDC" appears in
 * seven places on the site and has to be a real price on a real ring rather
 * than a rounding claim, and Moonbound at 20 is the ceiling.
 *
 * Four rings sit on the floor: Hex Nut, Washer Stack, Steel Wire, Rubber Band.
 *
 * The last two terms are the judgement calls: a hand-set mosaic is worth more
 * than a plain band of the same metal, and Moonbound is the only edition
 * anyone can be shut out of. A yellow gold twin of a white ring carries the
 * same workmanship number as its twin, so the two differ by exactly the
 * difference between their metals.
 */
export const RING_MODELS: RingModel[] = [
  // ---------------------------------------------------------------- Originals
  {
    id: 0,
    slug: "the-classic",
    name: "The Classic",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 9,
    maxSupply: 0,
    tagline: "The band your grandparents would recognize. Almost.",
    description:
      "A plain gold band, the way weddings have done it for a few thousand years. Ours weighs zero grams and survives everything, including the dishwasher.",
    collection: "Originals",
    images: ["/rings/the-originals/the-classic.jpg"],
  },
  {
    id: 1,
    slug: "solitaire",
    name: "Solitaire",
    material: "yellowGold",
    gem: "diamond",
    priceUsdc: 15,
    maxSupply: 0,
    tagline: "One diamond. The classic move.",
    description:
      "The engagement ring. A single diamond on a gold band, exactly like the expensive kind, minus the mining and the four months of salary.",
    collection: "Originals",
    images: ["/rings/the-originals/solitaire.jpg"],
  },
  {
    id: 2,
    slug: "something-blue",
    name: "Something Blue",
    material: "silver",
    gem: "sapphire",
    priceUsdc: 9,
    maxSupply: 0,
    tagline: "Your something blue, sorted forever.",
    description:
      "A sapphire on silver. Covers 'something blue' and 'something new' at once, leaving you only two more things to panic about.",
    collection: "Originals",
    images: ["/rings/the-originals/something-blue.jpg"],
  },
  {
    id: 3,
    slug: "cherry-on-top",
    name: "Cherry On Top",
    material: "roseGold",
    gem: "ruby",
    priceUsdc: 12,
    maxSupply: 0,
    tagline: "Rose gold, ruby, zero subtlety.",
    description:
      "The loudest ring in the Originals. A ruby on rose gold for couples who were never going to do quiet anyway.",
    collection: "Originals",
    images: ["/rings/the-originals/cherry-on-top.jpg"],
  },
  {
    id: 4,
    slug: "green-flag",
    name: "Green Flag",
    material: "yellowGold",
    gem: "emerald",
    priceUsdc: 13,
    maxSupply: 0,
    tagline: "They texted back. They minted a ring.",
    description:
      "An emerald on gold. Statistically the ring most often bought as a joke and kept with complete sincerity.",
    collection: "Originals",
    images: ["/rings/the-originals/green-flag.jpg"],
  },
  {
    id: 5,
    slug: "moonbound",
    name: "Moonbound",
    material: "platinum",
    gem: "diamond",
    priceUsdc: 20,
    maxSupply: 500,
    tagline: "Platinum and diamond. Limited to 500.",
    description:
      "The top of the line. Platinum band, diamond, edition of five hundred. The closest this shop gets to being serious.",
    collection: "Originals",
    images: ["/rings/the-originals/moonbound.jpg"],
  },
  {
    id: 6,
    slug: "lilac-hour",
    name: "Lilac Hour",
    material: "silver",
    gem: "amethyst",
    priceUsdc: 8,
    maxSupply: 0,
    tagline: "For the couple that met at 2am.",
    description:
      "An amethyst on silver, named after the hour when the best decisions and the best relationships tend to start.",
    collection: "Originals",
    images: ["/rings/the-originals/lilac-hour.jpg"],
  },
  {
    id: 7,
    slug: "quiet-luxury",
    name: "Quiet Luxury",
    material: "platinum",
    gem: "none",
    priceUsdc: 12,
    maxSupply: 1000,
    tagline: "A plain platinum band. If you know, you know.",
    description:
      "No gem, no shine, no explanation. A platinum band in an edition of one thousand, for people whose entire flex is refusing to flex.",
    collection: "Originals",
    images: ["/rings/the-originals/quiet-luxury.jpg"],
  },

  // ------------------------------------------------------------------- Honey
  {
    id: 8,
    slug: "donut-glaze",
    name: "Donut Glaze",
    material: "plastic",
    gem: "none",
    priceUsdc: 5,
    maxSupply: 1000,
    tagline: "Sweet, sticky, and strictly zero calories.",
    description:
      "A bright pink frosted donut with sprinkles. Perfect for the Homer Simpson in your life.",
    collection: "Honey",
    images: ["/rings/honey/donut-glaze.jpg"],
  },
  {
    id: 9,
    slug: "candy-pop",
    name: "Candy Pop",
    material: "glass",
    gem: "none",
    priceUsdc: 5,
    maxSupply: 1000,
    tagline: "A rainbow twist of pure sugar.",
    description:
      "A vibrant, twisted rainbow ring. Looks like hard candy, wears like a diamond, and will never once get sticky.",
    collection: "Honey",
    images: ["/rings/honey/candy-pop.jpg", "/rings/honey/candy-pop-on-hand.jpg"],
  },
  {
    id: 10,
    slug: "cookie-bite",
    name: "Cookie Bite",
    material: "plastic",
    gem: "none",
    priceUsdc: 4,
    maxSupply: 1000,
    tagline: "Someone already took a bite.",
    description:
      "A chocolate chip cookie with one bite already missing, which is how cookies are usually found. We are not asking who took it.",
    collection: "Honey",
    images: ["/rings/honey/cookie-bite.jpg", "/rings/honey/cookie-bite-on-hand.jpg"],
  },

  // ----------------------------------------------------------------- Pop Art
  {
    id: 11,
    slug: "disco-ring-white",
    name: "Disco Ring White",
    material: "whiteGold",
    gem: "none",
    priceUsdc: 11,
    maxSupply: 1000,
    tagline: "Studio 54 for your finger.",
    description:
      "Covered in tiny mirrored tiles of white gold, each one set to catch the light from a different angle. Saturday Night Fever is now permanent.",
    collection: "Pop Art",
    images: ["/rings/disco-ring-white-gold.jpg", "/rings/disco-ring-white-gold-on-hand.jpg"],
  },
  {
    // Out of numerical order on purpose: it reads next to the ring it is a
    // variant of, and deploy.ts sorts by id before seeding either way.
    id: 12,
    slug: "disco-ring",
    name: "Disco Ring",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 11,
    maxSupply: 1000,
    tagline: "Studio 54, after the lights came up.",
    description:
      "The same mosaic in yellow gold, which is what the mirrorball was always trying to be. Warmer than the white version and twice as hard to ignore across a room.",
    collection: "Pop Art",
    // No on-hand frame: recolor-artwork.mjs tints the whole picture, and that
    // shot is mostly hand.
    images: ["/rings/disco-ring-yellow-gold.jpg", "/rings/disco-ring-yellow-gold-on-hand.jpg"],
  },
  {
    id: 13,
    slug: "neon-loop-cyan",
    name: "Neon Loop Cyan",
    material: "glass",
    gem: "none",
    priceUsdc: 4,
    maxSupply: 1000,
    tagline: "Bright lights, big commitment.",
    description:
      "A glowing cyan loop of neon gas trapped in glass. Perfect for cyberpunk aesthetics.",
    collection: "Pop Art",
    images: ["/rings/neon-loop-cyan.jpg"],
  },
  {
    id: 14,
    slug: "neon-loop-magenta",
    name: "Neon Loop Magenta",
    material: "glass",
    gem: "none",
    priceUsdc: 4,
    maxSupply: 1000,
    tagline: "Cyberpunk romance.",
    description:
      "A vibrant magenta neon loop. Looks best at night, which works out nicely, because it never goes out.",
    collection: "Pop Art",
    images: ["/rings/neon-loop-magenta.jpg"],
  },
  {
    id: 15,
    slug: "lovebuoy",
    name: "Lovebuoy",
    material: "plastic",
    gem: "none",
    priceUsdc: 3,
    maxSupply: 1000,
    tagline: "Thrown to you at exactly the right moment.",
    description:
      "A life ring, in the most literal sense available. For the person who showed up when things were going under.",
    collection: "Pop Art",
    images: ["/rings/lovebuoy.jpg"],
  },
  {
    id: 16,
    slug: "puffy-clouds",
    name: "Puffy Clouds",
    material: "cotton",
    gem: "none",
    priceUsdc: 3,
    maxSupply: 1000,
    tagline: "Head in the clouds, ring on the finger.",
    description:
      "A ring made of small soft clouds – roughly what the first six months feel like. It weighs absolutely nothing, which is lucky, because you are meant to wear it for the rest of your life.",
    collection: "Pop Art",
    images: ["/rings/puffy-clouds.jpg"],
  },
  {
    id: 17,
    slug: "floating-flamingo",
    name: "Floating Flamingo",
    material: "plastic",
    gem: "none",
    priceUsdc: 4,
    maxSupply: 1000,
    tagline: "Pool party energy, wedding day commitment.",
    description:
      "An inflatable flamingo, sized for a finger. Ridiculous on purpose, and medically impossible to be in a bad mood about.",
    collection: "Pop Art",
    images: ["/rings/floating-flamingo.jpg"],
  },

  // -------------------------------------------------------------- Industrial
  {
    id: 18,
    slug: "mercury-ring",
    name: "Mercury Ring",
    material: "platinum",
    gem: "none",
    priceUsdc: 12,
    maxSupply: 1000,
    tagline: "Liquid metal, frozen in time.",
    description:
      "A ring that looks like a drop of liquid mercury, constantly shifting but never losing its shape.",
    collection: "Industrial",
    images: ["/rings/industrial/mercury-ring.jpg", "/rings/industrial/mercury-ring-on-hand.jpg"],
  },
  {
    id: 19,
    slug: "clamp-ring",
    name: "Clamp Ring",
    material: "silver",
    gem: "none",
    priceUsdc: 7,
    maxSupply: 1000,
    tagline: "Hardware store shape, jeweller's metal.",
    description:
      "A hose clamp, screw and all, struck in polished silver. The cheapest object in any workshop, made out of one of the more expensive things you can wear.",
    collection: "Industrial",
    images: ["/rings/industrial/clamp-ring.jpg", "/rings/industrial/clamp-ring-on-hand.jpg"],
  },
  {
    id: 20,
    slug: "bearing-white",
    name: "BeaRing White",
    material: "whiteGold",
    gem: "none",
    priceUsdc: 14,
    maxSupply: 1000,
    tagline: "Takes the pressure. Never squeaks.",
    description:
      "A ball bearing, the part that takes all the pressure and keeps everything turning smoothly. Choose your own metaphor here.",
    collection: "Industrial",
    images: ["/rings/industrial/bearing-white-gold.jpg", "/rings/industrial/bearing-white-gold-on-hand.jpg"],
  },
  {
    id: 21,
    slug: "paper-clip-white",
    name: "Paper Clip White",
    material: "whiteGold",
    gem: "none",
    priceUsdc: 10,
    maxSupply: 1000,
    tagline: "Holds things together. That is the whole job.",
    description:
      "One length of wire bent into the most reliable object ever invented. Underrated, like most good relationships",
    collection: "Industrial",
    images: ["/rings/industrial/paper-clip-white-gold.jpg", "/rings/industrial/paper-clip-white-gold-on-hand.jpg"],
  },
  {
    id: 22,
    slug: "spring",
    name: "Spring",
    material: "silver",
    gem: "none",
    priceUsdc: 8,
    maxSupply: 1000,
    tagline: "Bends under pressure, returns every time.",
    description:
      "A tight silver coil that takes the shock and returns to exactly where it started. Subtlety was never on the table here.",
    collection: "Industrial",
    images: ["/rings/industrial/spring.jpg", "/rings/industrial/spring-on-hand.jpg"],
  },
  {
    id: 23,
    slug: "wire-coil",
    name: "Wire Coil",
    material: "silver",
    gem: "none",
    priceUsdc: 9,
    maxSupply: 1000,
    tagline: "Wrapped around your finger. Obviously.",
    description:
      "Wire wound a few times around a finger, the oldest improvised ring there is. The difference is that this one cannot be quietly unwound and forgotten.",
    collection: "Industrial",
    images: ["/rings/industrial/wire-coil.jpg", "/rings/industrial/wire-coil-on-hand.jpg"],
  },
  {
    id: 24,
    slug: "neodymium",
    name: "Neodymium",
    material: "platinum",
    gem: "none",
    priceUsdc: 13,
    maxSupply: 1000,
    tagline: "Attraction, at an inconvenient strength.",
    description:
      "A rare earth magnet ring. Famously impossible to pull apart once two of them find each other, which is the entire point.",
    collection: "Industrial",
    images: ["/rings/industrial/neodymium.jpg", "/rings/industrial/neodymium-on-hand.jpg"],
  },

  /* Industrial in yellow gold.
   *
   * Same five shapes as their white twins, cast in the other metal, which is
   * how a jeweller's case has always worked. The artwork comes from
   * scripts/recolor-artwork.mjs rather than a new render — see the note there
   * for why these have one view where the white versions have two.
   *
   * Each price is its twin's price with the metal swapped underneath it: the
   * workmanship number is identical, so Paper Clip and Paper Clip Gold cost the
   * same (white and yellow gold share a floor) while Spring gains the nine that
   * separates silver from gold. */
  {
    id: 25,
    slug: "paper-clip",
    name: "Paper Clip",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 10,
    maxSupply: 1000,
    tagline: "The paperclip chain, taken literally.",
    description:
      "Gold paperclip chains have been a jewellery counter staple for years. This is an actual paperclip, in gold, worn as the ring. The joke got there first.",
    collection: "Industrial",
    images: ["/rings/industrial/paper-clip-yellow-gold.jpg", "/rings/industrial/paper-clip-yellow-gold-on-hand.jpg"],
  },
  /*{
    id: 0, // disabled: give it the next free id when re-enabling
    slug: "clamp-ring-gold",
    name: "Clamp Ring Gold",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 11,
    maxSupply: 1000,
    tagline: "Tightened to spec, in the good metal.",
    description:
      "A hose clamp in yellow gold, screw and all. Hardware that went to the jeweller and came back refusing to explain itself.",
    collection: "Industrial",
    images: ["/rings/industrial/clamp-ring-gold.jpg"],
  }, */
  /*{
    id: 0, // disabled: give it the next free id when re-enabling
    slug: "spring-gold",
    name: "Spring Gold",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 12,
    maxSupply: 1000,
    tagline: "Still returns. Now impossible to ignore.",
    description:
      "The same tight coil in yellow gold. It takes the same shock and comes back to the same place, considerably louder about having done it.",
    collection: "Industrial",
    images: ["/rings/industrial/spring-gold.jpg"],
  }, */
  /*{
    id: 0, // disabled: give it the next free id when re-enabling
    slug: "wire-coil-gold",
    name: "Wire Coil Gold",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 13,
    maxSupply: 1000,
    tagline: "Wrapped around your finger, in gold.",
    description:
      "The oldest improvised ring there is, wound in gold wire instead. Same knot, same idea, much harder to pass off as something you did absentmindedly.",
    collection: "Industrial",
    images: ["/rings/industrial/wire-coil-gold.jpg"],
  }, */
  {
    id: 26,
    slug: "bearing",
    name: "BeaRing",
    material: "yellowGold",
    gem: "none",
    priceUsdc: 14,
    maxSupply: 1000,
    tagline: "Every ball, in gold.",
    description:
      "The same bearing, cast in yellow gold, which turns a few hundred load-bearing spheres into the most convincing caviar band ever to come off a workbench.",
    collection: "Industrial",
    images: ["/rings/industrial/bearing-yellow-gold.jpg", "/rings/industrial/bearing-yellow-gold-on-hand.jpg"],
  },

  // ------------------------------------------------------------ Garage Gems
  {
    id: 27,
    slug: "zip-tie-white",
    name: "Zip Tie White",
    material: "plastic",
    gem: "none",
    priceUsdc: 2,
    maxSupply: 1000,
    tagline: "Goes on once. Comes off with scissors.",
    description:
      "A white cable tie, pulled tight. The most permanent fastener ever made for something that costs a cent.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/zip-tie-white.jpg", "/rings/garage-gems/zip-tie-white-on-hand.jpg"],
  },
  {
    id: 28,
    slug: "zip-tie-black",
    name: "Zip Tie Black",
    material: "plastic",
    gem: "none",
    priceUsdc: 2,
    maxSupply: 1000,
    tagline: "The same commitment, in black.",
    description:
      "A black cable tie for people who wanted the zip tie but also wanted it to go with everything.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/zip-tie-black.jpg", "/rings/garage-gems/zip-tie-black-on-hand.jpg"],
  },
  {
    id: 29,
    slug: "hex-nut",
    name: "Hex Nut",
    material: "steel",
    gem: "none",
    priceUsdc: 1,
    maxSupply: 1000,
    tagline: "Gave her your nut.",
    description:
      "Six flat sides, one thread, zero pretense. The hardware aisle version of a signet ring.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/hex-nut.jpg", "/rings/garage-gems/hex-nut-on-hand.jpg"],
  },
  {
    id: 30,
    slug: "washer-stack",
    name: "Washer Stack",
    material: "steel",
    gem: "none",
    priceUsdc: 1,
    maxSupply: 1000,
    tagline: "Three washers. One decision.",
    description:
      "A stack of steel washers doing an excellent impression of a stacking ring set. Costs about eleven cents in real life.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/washer-stack.jpg", "/rings/garage-gems/washer-stack-on-hand.jpg"],
  },
  {
    id: 31,
    slug: "steel-wire",
    name: "Steel Wire",
    material: "steel",
    gem: "none",
    priceUsdc: 1,
    maxSupply: 1000,
    tagline: "Steel wire, still a ring.",
    description:
      "A single loop of steel wire with the ends twisted shut. The kind of ring you make at 1am because you could not wait until the shops opened.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/steel-wire.jpg", "/rings/garage-gems/steel-wire-on-hand.jpg"],
  },
  {
    id: 32,
    slug: "metal-clamp",
    name: "Metal Clamp",
    material: "steel",
    gem: "none",
    priceUsdc: 2,
    maxSupply: 1000,
    tagline: "Tightened to spec.",
    description:
      "A worm gear clamp with a real screw, so it technically adjusts to any finger. We still recommend picking your size properly.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/metal-clamp.jpg", "/rings/garage-gems/metal-clamp-on-hand.jpg"],
  },
  {
    id: 33,
    slug: "rubber-band",
    name: "Rubber Band",
    material: "rubber",
    gem: "none",
    priceUsdc: 1,
    maxSupply: 1000,
    tagline: "Stretches. Does not break.",
    description:
      "The ring you improvise in an office at 6pm when the question cannot wait another day. Now in a version that does not snap.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/rubber-band.jpg", "/rings/garage-gems/rubber-band-on-hand.jpg"],
  },
  {
    id: 34,
    slug: "copper-wire",
    name: "Copper Wire",
    material: "copper",
    gem: "none",
    priceUsdc: 3,
    maxSupply: 1000,
    tagline: "Conducts everything except doubt.",
    description:
      "Bare copper, wound and warm toned, the closest the workbench gets to gold. It will patina in real life. This one will not.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/copper-wire.jpg", "/rings/garage-gems/copper-wire-on-hand.jpg"],
  },
  {
    id: 35,
    slug: "joining-ring",
    name: "Joining Ring",
    material: "bronze",
    gem: "none",
    priceUsdc: 2,
    maxSupply: 1000,
    tagline: "Made to bring things together.",
    description:
      "A small piece of hardware whose whole job is bringing things together. We can get behind that.",
    collection: "Garage Gems",
    images: ["/rings/garage-gems/joining-ring.jpg", "/rings/garage-gems/joining-ring-on-hand.jpg"],
  },
];

export function getModelBySlug(slug: string): RingModel | undefined {
  return RING_MODELS.find((m) => m.slug === slug);
}

export function getModelById(id: number): RingModel | undefined {
  return RING_MODELS.find((m) => m.id === id);
}

export function modelsInCollection(key: CollectionKey): RingModel[] {
  return RING_MODELS.filter((m) => m.collection === key);
}

/** Formats a USDC price for display. */
export function formatUsdc(amount: number): string {
  return `${amount} USDC`;
}

/* -------------------------------------------------------------------------
 * Sizes
 *
 * The contract stores US sizes in half-steps (6..27 => US 3.0..13.5). Every
 * other system is derived from the same physical measurement, so nothing is
 * lost: ISO 8653 defines a ring size as its inner circumference in mm.
 * ---------------------------------------------------------------------- */

export const SIZE_MIN = 6;
export const SIZE_MAX = 27;
export const ALL_SIZES = Array.from({ length: SIZE_MAX - SIZE_MIN + 1 }, (_, i) => SIZE_MIN + i);

/**
 * US 5 to 10, which covers the large majority of adult fingers. Showing the
 * full 22-step range up front turns the most important decision on the page
 * into a wall of numbers, so the rest is one click away instead.
 */
export const COMMON_SIZES = ALL_SIZES.filter((s) => s >= 10 && s <= 20);

/** US 3.0 has an inner diameter of 11.63mm + 0.4064mm per half-step. */
export function diameterMm(halfSteps: number): number {
  return 11.63 + 0.4064 * halfSteps;
}

export function circumferenceMm(halfSteps: number): number {
  return Math.round(diameterMm(halfSteps) * Math.PI * 10) / 10;
}

export function usLabel(halfSteps: number): string {
  const whole = Math.floor(halfSteps / 2);
  return halfSteps % 2 === 0 ? `${whole}` : `${whole}.5`;
}

/** EU / ISO 8653 size is the inner circumference rounded to a whole mm. */
export function euLabel(halfSteps: number): string {
  return `${Math.round(circumferenceMm(halfSteps))}`;
}

/**
 * Mainland China and Japan number sizes on the same circumference basis,
 * roughly one step per millimetre starting near 40mm. Retailers vary by up to
 * a size, which is why the guide always shows the millimetres next to it.
 */
export function cnLabel(halfSteps: number): string {
  const value = Math.round((circumferenceMm(halfSteps) - 40.2) * 2) / 2;
  return `${value}`;
}

export type SizeUnit = "us" | "eu" | "mm";

export const SIZE_UNITS: { key: SizeUnit; label: string; hint: string }[] = [
  { key: "us", label: "US", hint: "US / Canada numbering" },
  { key: "eu", label: "EU", hint: "ISO 8653, inner circumference in mm" },
  { key: "mm", label: "mm", hint: "Inner circumference" },
];

export function sizeLabel(halfSteps: number, unit: SizeUnit = "us"): string {
  if (unit === "eu") return euLabel(halfSteps);
  if (unit === "mm") return circumferenceMm(halfSteps).toFixed(1);
  return usLabel(halfSteps);
}

/** Full conversion row for the size guide. */
export interface SizeRow {
  halfSteps: number;
  us: string;
  eu: string;
  cn: string;
  diameter: string;
  circumference: string;
}

export const SIZE_TABLE: SizeRow[] = ALL_SIZES.map((halfSteps) => ({
  halfSteps,
  us: usLabel(halfSteps),
  eu: euLabel(halfSteps),
  cn: cnLabel(halfSteps),
  diameter: diameterMm(halfSteps).toFixed(1),
  circumference: circumferenceMm(halfSteps).toFixed(1),
}));

/** The most commonly ordered size, used as the default selection. */
export const DEFAULT_SIZE = 14; // US 7

export const MAX_INSCRIPTION_CHARS = 64;
export const MAX_MESSAGE_CHARS = 280;

/**
 * Length the way the contract counts it: Unicode codepoints, not UTF-16 code
 * units. "Аня" is 3 either way, but an emoji is 1 here and 2 to String.length,
 * and the limit the user is shown has to be the limit the chain enforces.
 */
export function textLength(text: string): number {
  return [...text].length;
}

/**
 * Mirrors the contract's charset rule. Any language is allowed; the only
 * rejects are the three things that would break the JSON that tokenURI
 * assembles by hand: a double quote, a backslash, and control characters.
 */
export function validText(text: string): boolean {
  return !/["\\\u0000-\u001F\u007F]/.test(text);
}

/** The single reason a piece of text cannot be minted, or null when it is fine. */
export function textError(text: string, maxChars: number): string | null {
  if (!validText(text)) return "No quotes or backslashes, please. Everything else is fair game.";
  if (textLength(text) > maxChars) return `That is ${textLength(text) - maxChars} characters too long.`;
  return null;
}

/**
 * What two rings cost bought together. Mirrors PAIR_DISCOUNT_BPS in the
 * contract; the chain remains the authority, this is for the price shown
 * before a wallet is connected.
 */
export const PAIR_DISCOUNT = 0.1;

export function pairPriceUsdc(price: number): number {
  return price * 2 * (1 - PAIR_DISCOUNT);
}
