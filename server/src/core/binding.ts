// OT3-178: bound items. A quest item (content table questItems) never leaves its holder. A
// notable item (notableItems: artifacts, uniques) taken from loot stays tradeable for 2 hours
// among the party present when it was taken, then binds. Neither may be dropped or put in a
// container (a merchant's stock is a container): the world is how an item reaches anyone.
//
// Player death drops nothing in this game, so trade, drop and container are the exits.
// ponytail: loot windows live in memory; a restart binds every open one early (fail-safe).
// Persist them on the player doc if that ever bites.

export const LOOT_WINDOW_MS = 2 * 60 * 60 * 1000;

export class Binding {
  private readonly windows = new Map<string, { until: number; party: Set<string> }>(); // charId|id

  constructor(private readonly quest: ReadonlySet<string>, private readonly notable: ReadonlySet<string>,
    private readonly now: () => number = Date.now) {}

  /** May not go to the ground or a container, ever. */
  isBound(id: string): boolean {
    const k = id.toLowerCase();
    return this.quest.has(k) || this.notable.has(k);
  }

  /** A notable item looted by `charId` with these characters (them included) standing there. */
  noteLoot(charId: string, id: string, party: string[]): void {
    const k = id.toLowerCase();
    if (!this.notable.has(k)) return;
    this.windows.set(`${charId}|${k}`, { until: this.now() + LOOT_WINDOW_MS, party: new Set([charId, ...party]) });
  }

  /** May `from` hand this to `to` in a trade? */
  mayTrade(from: string, to: string, id: string): boolean {
    const k = id.toLowerCase();
    if (this.quest.has(k)) return false;
    if (!this.notable.has(k)) return true;
    const w = this.windows.get(`${from}|${k}`);
    return w !== undefined && w.until > this.now() && w.party.has(to);
  }

  /** The window travels with the item: the new holder may pass it on within the same party and time. */
  handedOver(from: string, to: string, id: string): void {
    const k = id.toLowerCase();
    const w = this.windows.get(`${from}|${k}`);
    if (w) this.windows.set(`${to}|${k}`, w);
  }
}
