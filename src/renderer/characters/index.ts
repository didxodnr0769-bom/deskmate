import { CHARACTER_OPTIONS, type CharacterId } from '../../shared/appearance';
import type { CharacterDefinition } from '../character-runtime';
import { rock } from './rock';
import { cat } from './cat';
import { rabbit } from './rabbit';
import { chelsea } from './chelsea';

const definitions: Record<CharacterId, CharacterDefinition> = { rock, cat, rabbit, chelsea };
export const BUILT_IN_CHARACTERS = CHARACTER_OPTIONS.map(option => definitions[option.id]);
export function getCharacterDefinition(id: CharacterId): CharacterDefinition { return definitions[id] ?? rock; }
