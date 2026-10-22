import { CHARACTER_OPTIONS, type CharacterId } from '../../shared/appearance';
import type { CharacterDefinition } from '../character-runtime';
import { rock } from './rock';
import { cat } from './cat';
import { rabbit } from './rabbit';
import { chelsea } from './chelsea';
import { chuchu } from './chuchu';

const definitions: Record<CharacterId, CharacterDefinition> = { rock, cat, rabbit, chelsea, chuchu };
export const BUILT_IN_CHARACTERS = CHARACTER_OPTIONS.map(option => definitions[option.id]);
export function getCharacterDefinition(id: CharacterId): CharacterDefinition { return definitions[id] ?? rock; }
