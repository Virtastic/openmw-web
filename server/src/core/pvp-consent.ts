// OT3-163: PvP by consent. Nobody hurts another player unless both said yes:
//   - a DUEL: DuelRequest{name} challenges someone in your cell; the same request back within
//     30 s starts it (one button on the Players row does both). It ends on a death, a
//     disconnect or after 10 minutes.
//   - the FLAG (WoW War Mode): PvpFlag{state on|off|toggle}, only inside a temple or a town
//     building, at most once per 5 minutes per character. Two flagged players may fight
//     wherever the operator's pvpZone allows. A relog drops the flag but not the cooldown.
//   - the ARENA: both standing in the Vivec Arena pit. Walking in is the opt-in.
// The pvp builtin asks `consent()`; respawn asks `diedInDuel()` to waive the OT3-175 debuff.
// ponytail: in memory on purpose (a duel or flag means "right now"); a restart clears both.

import type { Player } from './players';
import type { LValue } from '../proto/lser';
import { log } from '../log';

export const DUEL_ASK_MS = 30_000;
export const DUEL_MAX_MS = 10 * 60_000;
export const FLAG_COOLDOWN_MS = 5 * 60_000;
const DUEL_DEATH_MS = 2 * 60_000; // a duel death still counts when the respawn lands later

const ARENA = /^vivec, arena pit$/i;
// Interiors only: an exterior key is "x,y" and says nothing about whether it is a town.
// ponytail: town exteriors need a coordinate table; add one if players ask to flag in the street.
const FLAG_PLACE = /^(balmora|vivec|ald'ruhn|sadrith mora|ebonheart|caldera|pelagiad|suran|gnisis|maar gan|molag mar|tel branora|tel aruhn|tel mora|tel vos|khuul|dagon fel|gnaar mok|hla oad|ald velothi|seyda neen|ghostgate)\b|\btemple\b/i;

export type Consent = 'duel' | 'flag' | 'arena';

export interface ConsentDeps {
  findByName(name: string): Player | undefined;
  byId(id: number): Player | undefined;
  tell(p: Player, text: string): void;
  now(): number;
}

export class PvpConsent {
  private readonly asks = new Map<string, number>(); // `${from}>${to}` -> at
  private readonly duels = new Map<number, { with: number; until: number }>();
  private readonly flagged = new Set<number>();
  private readonly flagChangedAt = new Map<string, number>(); // character name, lowercase
  private readonly duelDeaths = new Map<number, number>();

  constructor(private readonly d: ConsentDeps) {}

  handleEvent(p: Player, name: string, value: LValue | undefined): boolean {
    const body = value instanceof Map ? value : undefined;
    const str = (k: string): string => { const v = body?.get(k); return typeof v === 'string' ? v : ''; };
    switch (name) {
      case 'DuelRequest': this.duel(p, str('name')); return true;
      case 'PvpFlag': this.flag(p, str('state')); return true;
      default: return false;
    }
  }

  consent(attackerId: number, victimId: number): Consent | undefined {
    const duel = this.duels.get(attackerId);
    if (duel && duel.with === victimId && this.d.now() < duel.until) return 'duel';
    const a = this.d.byId(attackerId), v = this.d.byId(victimId);
    if (a && v && ARENA.test(a.cellKey ?? '') && ARENA.test(v.cellKey ?? '')) return 'arena';
    if (this.flagged.has(attackerId) && this.flagged.has(victimId)) return 'flag';
    return undefined;
  }

  /** Idempotent: the pvp builtin calls it on PlayerDeath, respawn again when it resurrects. */
  diedInDuel(id: number): boolean {
    const now = this.d.now();
    const duel = this.duels.get(id);
    if (duel) {
      this.duels.delete(id);
      this.duels.delete(duel.with);
      const me = this.d.byId(id), them = this.d.byId(duel.with);
      if (now < duel.until) {
        this.duelDeaths.set(id, now);
        const text = `${them?.name ?? 'Someone'} won the duel against ${me?.name ?? 'someone'}.`;
        for (const p of [me, them]) if (p) this.d.tell(p, text);
        log('info', 'pvp.duel_won', { winner: them?.name, loser: me?.name });
      }
    }
    const at = this.duelDeaths.get(id);
    if (at !== undefined && now - at < DUEL_DEATH_MS) return true;
    return ARENA.test(this.d.byId(id)?.cellKey ?? '');
  }

  /** Leaving ends a duel (no winner) and drops the flag; the flag cooldown stays. */
  end(p: Player): void {
    const duel = this.duels.get(p.id);
    if (duel) {
      this.duels.delete(p.id);
      this.duels.delete(duel.with);
      const them = this.d.byId(duel.with);
      if (them) this.d.tell(them, `${p.name} left; the duel is over.`);
    }
    this.flagged.delete(p.id);
    for (const k of this.asks.keys()) if (k.startsWith(`${p.id}>`) || k.endsWith(`>${p.id}`)) this.asks.delete(k);
  }

  private duel(p: Player, name: string): void {
    const t = this.d.findByName(name);
    if (!t || t.id === p.id || !t.inWorld) return this.d.tell(p, 'There is nobody by that name here to duel.');
    if (t.cellKey !== p.cellKey) return this.d.tell(p, `${t.name} is too far away to duel.`);
    const now = this.d.now();
    for (const x of [p, t]) {
      const busy = this.duels.get(x.id);
      if (busy && now < busy.until) return this.d.tell(p, `${x.id === p.id ? 'You are' : `${t.name} is`} already in a duel.`);
    }
    const theirs = this.asks.get(`${t.id}>${p.id}`);
    if (theirs !== undefined && now - theirs < DUEL_ASK_MS) {
      this.asks.delete(`${t.id}>${p.id}`);
      const until = now + DUEL_MAX_MS;
      this.duels.set(p.id, { with: t.id, until });
      this.duels.set(t.id, { with: p.id, until });
      for (const x of [p, t]) this.d.tell(x, `The duel between ${t.name} and ${p.name} begins. The first to fall loses.`);
      log('info', 'pvp.duel_start', { a: t.name, b: p.name });
      return;
    }
    this.asks.set(`${p.id}>${t.id}`, now);
    this.d.tell(t, `${p.name} challenges you to a duel. Press duel on their row within 30 seconds to accept.`);
    this.d.tell(p, `You challenged ${t.name} to a duel.`);
  }

  private flag(p: Player, state: string): void {
    const on = state === 'toggle' ? !this.flagged.has(p.id) : state === 'on';
    if (on === this.flagged.has(p.id)) return this.d.tell(p, `Your PvP flag is already ${on ? 'on' : 'off'}.`);
    if (!FLAG_PLACE.test(p.cellKey ?? '') || /^-?\d+,-?\d+$/.test(p.cellKey ?? '')) {
      return this.d.tell(p, 'You can only change your PvP flag inside a temple or a town building.');
    }
    const key = p.name.toLowerCase();
    const now = this.d.now();
    const last = this.flagChangedAt.get(key);
    if (last !== undefined && now - last < FLAG_COOLDOWN_MS) {
      return this.d.tell(p, `You changed your PvP flag recently. Try again in ${Math.ceil((FLAG_COOLDOWN_MS - (now - last)) / 60_000)} min.`);
    }
    this.flagChangedAt.set(key, now);
    if (on) this.flagged.add(p.id); else this.flagged.delete(p.id);
    this.d.tell(p, on ? 'PvP flag ON: other flagged players can attack you, and you them.' : 'PvP flag OFF.');
    log('info', 'pvp.flag', { name: p.name, on });
  }
}
