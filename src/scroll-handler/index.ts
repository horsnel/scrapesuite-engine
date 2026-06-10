export { ScrollHandlerManager } from './manager';
export { generateScrollAmount, generateWaitTime, shouldScrollUp, getBehaviorProfile } from './behavior';
export type { ScrollStrategy, TerminationCondition, ExtractionStrategy, ExtractionField, ExtractionConfig, ScrollConfig, ScrollResult, ScrollSessionInfo, ScrollHandlerStats } from './types';
import { ScrollHandlerManager } from './manager';
export const scrollHandler = new ScrollHandlerManager();
