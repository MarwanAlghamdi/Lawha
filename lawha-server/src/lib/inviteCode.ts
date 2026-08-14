import { randomInt } from "node:crypto";

/**
 * The three-word invite code — the thing a person says out loud.
 *
 * A code exists to be handed over by whatever channel is to hand: read across
 * a desk, spoken down a phone, typed into a chat. That rules out the shape
 * every other identifier in Lawha has. A board id is 10 random bytes as hex,
 * which is unimpeachable as entropy and unusable as speech — nobody dictates
 * `f5d0d3ee863903779dd3` twice the same way.
 *
 * So: three words, hyphenated, from a fixed list of {@link WORD_COUNT}.
 *
 * **This buys speakability with entropy, and the trade is real.** 256³ is
 * about 16.7 million codes — far short of the 2^80 in a board id, and small
 * enough that an unthrottled attacker would find a live one. It is paid for
 * three ways, and all three are load-bearing rather than defence in depth:
 *
 *   1. **Redemption is rate limited** in `http/routes/invites.ts`, per address
 *      and per account. At the limit there, exhausting even 1% of the space
 *      takes centuries.
 *   2. **Codes expire**, and the UI always sets an expiry. The space an
 *      attacker is searching is not "every code ever" but "codes live right
 *      now", which on a LAN deployment is a handful.
 *   3. **A hit grants membership of one board at a role the owner chose**,
 *      never ownership — see the migration. It is not a foothold in the
 *      account.
 *
 * The word list is chosen so a code survives being spoken: no homophones
 * (`newt`/`neat` was caught and removed), no near-rhymes inside the list
 * (`basket`/`bucket`, `tide`/`tidy`, `vale`/`valley`, `yarn`/`yarrow` — all
 * caught the same way), nothing with a spelling you would have to ask about,
 * and nothing that could land badly when read aloud to a room.
 */

const ANIMALS = [
  "otter",
  "badger",
  "falcon",
  "heron",
  "lynx",
  "meerkat",
  "walrus",
  "gecko",
  "ibex",
  "koala",
  "lemur",
  "magpie",
  "narwhal",
  "ocelot",
  "puffin",
  "quail",
  "raven",
  "seal",
  "tapir",
  "urchin",
  "viper",
  "wombat",
  "yak",
  "zebra",
  "beetle",
  "cobra",
  "dingo",
  "eagle",
  "ferret",
  "gibbon",
  "hornet",
  "iguana",
  "jackal",
  "kestrel",
  "llama",
  "mantis",
  "gannet",
  "osprey",
  "panda",
  "python",
  "robin",
  "salmon",
  "tiger",
  "turtle",
  "vulture",
  "weasel",
  "bison",
  "camel",
  "dolphin",
  "elk",
  "finch",
  "goose",
  "hare",
  "jaguar",
  "kiwi",
  "lobster",
  "moose",
  "oyster",
  "parrot",
  "rabbit",
  "shark",
  "sparrow",
  "toad",
  "wolf",
];

const NATURE = [
  "amber",
  "birch",
  "canyon",
  "delta",
  "ember",
  "fern",
  "glacier",
  "harbor",
  "island",
  "jungle",
  "kelp",
  "lagoon",
  "meadow",
  "nebula",
  "oasis",
  "prairie",
  "quartz",
  "ridge",
  "summit",
  "tundra",
  "valley",
  "willow",
  "cedar",
  "dune",
  "forest",
  "granite",
  "hollow",
  "iris",
  "juniper",
  "lichen",
  "marsh",
  "orchid",
  "pebble",
  "geyser",
  "reef",
  "savanna",
  "thicket",
  "umber",
  "vine",
  "wetland",
  "aspen",
  "basalt",
  "cliff",
  "dusk",
  "estuary",
  "fjord",
  "grove",
  "heath",
  "inlet",
  "canopy",
  "knoll",
  "lily",
  "mesa",
  "nectar",
  "oak",
  "pine",
  "rapids",
  "shale",
  "tide",
  "upland",
  "vista",
  "wave",
  "thistle",
  "zenith",
];

const OBJECTS = [
  "anchor",
  "beacon",
  "compass",
  "drum",
  "easel",
  "flask",
  "gavel",
  "hammer",
  "ink",
  "kettle",
  "ladder",
  "mirror",
  "needle",
  "oven",
  "pencil",
  "quilt",
  "ribbon",
  "saddle",
  "teapot",
  "umbrella",
  "vessel",
  "wagon",
  "anvil",
  "basket",
  "candle",
  "dagger",
  "engine",
  "fabric",
  "goblet",
  "helmet",
  "jar",
  "kite",
  "lantern",
  "mallet",
  "nozzle",
  "organ",
  "piston",
  "rope",
  "satchel",
  "timber",
  "valve",
  "wrench",
  "arrow",
  "trowel",
  "chisel",
  "dial",
  "envelope",
  "funnel",
  "gear",
  "hinge",
  "key",
  "lever",
  "magnet",
  "nail",
  "oar",
  "plank",
  "ratchet",
  "sickle",
  "tunnel",
  "velvet",
  "wheel",
  "yarn",
  "zipper",
  "bell",
];

const QUALITIES = [
  "bright",
  "calm",
  "crisp",
  "deep",
  "eager",
  "fair",
  "gentle",
  "happy",
  "ideal",
  "jolly",
  "keen",
  "lively",
  "mellow",
  "noble",
  "sunny",
  "proud",
  "quiet",
  "ready",
  "swift",
  "sturdy",
  "upbeat",
  "vivid",
  "warm",
  "zesty",
  "brave",
  "clever",
  "daring",
  "earnest",
  "fluent",
  "glad",
  "humble",
  "joyful",
  "kindly",
  "loyal",
  "merry",
  "polite",
  "orderly",
  "patient",
  "quick",
  "robust",
  "steady",
  "tender",
  "useful",
  "valiant",
  "witty",
  "agile",
  "bold",
  "cheerful",
  "dapper",
  "elegant",
  "fond",
  "graceful",
  "hearty",
  "jaunty",
  "lucid",
  "modest",
  "nimble",
  "placid",
  "radiant",
  "serene",
  "trusty",
  "urbane",
  "vibrant",
  "winsome",
];

/**
 * The list a code is drawn from, in a fixed order.
 *
 * Fixed because the order is not load-bearing — selection is uniform over the
 * whole list, not one word per group — but reordering it would still be a
 * pointless way to make old codes unreadable if this ever became an index
 * rather than a set of literals.
 */
export const INVITE_WORDS: readonly string[] = [
  ...QUALITIES,
  ...ANIMALS,
  ...NATURE,
  ...OBJECTS,
];

export const WORDS_PER_CODE = 3;

/** Kept as a named export so the entropy claim above can be asserted in a test. */
export const WORD_COUNT = INVITE_WORDS.length;

/**
 * Mints a code.
 *
 * `randomInt` rather than `Math.random()`: this is a credential, and the
 * rejection sampling that makes the draw uniform is exactly the part a
 * hand-rolled modulo gets wrong.
 */
export const generateInviteCode = (): string =>
  Array.from(
    { length: WORDS_PER_CODE },
    () => INVITE_WORDS[randomInt(INVITE_WORDS.length)],
  ).join("-");

/**
 * What the user typed, turned into what the database stores — or null.
 *
 * People retype a code the way they heard it, which means spaces instead of
 * hyphens, capitals at the start of each word, a trailing full stop, and the
 * odd double space. All of that is the same code, and refusing it would make a
 * spoken credential unusable for the reason it exists.
 *
 * What is *not* forgiven is a word that is not on the list. Correcting a near
 * miss would turn a typo into someone else's board.
 */
export const normalizeInviteCode = (input: string): string | null => {
  const words = input
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (words.length !== WORDS_PER_CODE) {
    return null;
  }
  if (!words.every((word) => INVITE_WORDS.includes(word))) {
    return null;
  }
  return words.join("-");
};
