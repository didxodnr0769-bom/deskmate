/// <reference types="vite/client" />
import type { CompanionApi } from '../shared/contracts';
declare global { interface Window { companion: CompanionApi } }
export {};
