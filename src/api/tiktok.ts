/**
 * TikTok API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for TikTok anti-bot counter-measures.
 */

import type { FastifyInstance } from 'fastify';
import { tiktokManager, xbogusSigner, msTokenRotator, deviceRegistrar, tiktokSignatureEngine, feedSimulator } from '../platforms/tiktok';
import type { TikTokDeviceType, SignatureRequest } from '../platforms/tiktok';

export async function tiktokRoutes(app: FastifyInstance): Promise<void> {
  // Initialize TikTok manager
  app.post('/v1/tiktok/initialize', async () => {
    await tiktokManager.initialize();
    return { success: true, message: 'TikTok manager initialized' };
  });

  // Quick-sign a URL
  app.post('/v1/tiktok/sign', async (request) => {
    const body = request.body as { url: string; deviceType?: TikTokDeviceType };
    const result = await tiktokManager.quickSign(body.url, body.deviceType);
    return result;
  });

  // Full sign request
  app.post('/v1/tiktok/sign/full', async (request) => {
    const signRequest = request.body as SignatureRequest;
    const result = await tiktokManager.signRequest(signRequest);
    return result;
  });

  // Get fresh msToken
  app.get('/v1/tiktok/mstoken', async () => {
    const token = tiktokManager.getMsToken();
    return { msToken: token };
  });

  // Rotate msToken
  app.post('/v1/tiktok/mstoken/rotate', async () => {
    const token = tiktokManager.rotateMsToken();
    return { msToken: token };
  });

  // Rotate device
  app.post('/v1/tiktok/device/rotate', async (request) => {
    const body = request.body as { deviceType?: TikTokDeviceType };
    const result = await tiktokManager.rotateDevice(body.deviceType);
    return result;
  });

  // Generate feed simulation
  app.get('/v1/tiktok/feed/simulate', async () => {
    const result = tiktokManager.simulateFeed();
    return result;
  });

  // Prepare a complete session
  app.post('/v1/tiktok/session/prepare', async (request) => {
    const body = request.body as { deviceType?: TikTokDeviceType; proxyTier?: 'residential' | 'mobile' };
    const session = await tiktokManager.prepareSession(body);
    return session;
  });

  // Record detection encounter
  app.post('/v1/tiktok/detection', async (request) => {
    const body = request.body as { type: string };
    tiktokManager.recordDetection(body.type);
    return { recorded: true };
  });

  // Get TikTok manager stats
  app.get('/v1/tiktok/stats', async () => {
    return tiktokManager.getStats();
  });

  // X-Bogus signer stats
  app.get('/v1/tiktok/xbogus/stats', async () => {
    return xbogusSigner.getStats();
  });

  // msToken rotator stats
  app.get('/v1/tiktok/mstoken/stats', async () => {
    return msTokenRotator.getStats();
  });

  // Device registrar stats
  app.get('/v1/tiktok/device/stats', async () => {
    return deviceRegistrar.getStats();
  });

  // Signature engine stats
  app.get('/v1/tiktok/signature/stats', async () => {
    return tiktokSignatureEngine.getStats();
  });

  // Feed simulator stats
  app.get('/v1/tiktok/feed/stats', async () => {
    return feedSimulator.getStats();
  });
}
