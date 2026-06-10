export { NetworkCaptureManager } from './manager';
export { matchFilter, computeBodyHash, DEFAULT_FILTER } from './filter';
export type { CaptureFilter, CapturedResponse, CaptureSession, CaptureSessionInfo, StartCaptureOptions, CaptureQueryOptions, CaptureStats } from './types';
import { NetworkCaptureManager } from './manager';
export const networkCaptureManager = new NetworkCaptureManager();
