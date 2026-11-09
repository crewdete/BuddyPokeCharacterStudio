import { useSyncExternalStore } from 'react';
import type { AnimationPlayer, PlayerSnapshot } from '../pose/player';

/** Live player state for React (re-renders on every player change, including each played frame). */
export function usePlayer(player: AnimationPlayer): PlayerSnapshot {
  return useSyncExternalStore(
    listener => player.subscribe(listener),
    () => player.snapshot(),
  );
}
