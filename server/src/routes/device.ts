import express from 'express';
import {
  deviceControlEnabled,
  setDeviceControlEnabled,
  enqueueDeviceAction,
  takePendingDeviceAction,
  completeDeviceAction,
  getDeviceAction,
  deviceStatusSummary,
  type DeviceActionType,
} from '../device.js';

const router = express.Router();

/** GET /api/v1/device/status — 设备控制总状态（设置页与 agent 使用） */
router.get('/status', (_req: express.Request, res: express.Response) => {
  const pending = takePendingDeviceAction();
  res.json({
    enabled: deviceControlEnabled(),
    pending: pending ? { id: pending.id, type: pending.type } : null,
    summary: deviceStatusSummary(),
  });
});

/** POST /api/v1/device/enable — 启停设备控制（仅记录偏好，实际执行依赖无障碍服务） */
router.post('/enable', (req: express.Request, res: express.Response) => {
  const { enabled } = req.body as { enabled?: boolean };
  setDeviceControlEnabled(enabled === true);
  res.json({ enabled: enabled === true });
});

/** GET /api/v1/device/pending — 原生桥轮询：取一条待执行动作 */
router.get('/pending', (_req: express.Request, res: express.Response) => {
  const action = takePendingDeviceAction();
  res.json({ action });
});

/** POST /api/v1/device/result — 原生桥回传动作执行结果 */
router.post('/result', (req: express.Request, res: express.Response) => {
  const { id, ok, result, error } = req.body as { id?: string; ok?: boolean; result?: string; error?: string };
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  const action = completeDeviceAction(id, ok === true, result, error);
  res.json({ success: !!action, id });
});

/** POST /api/v1/device/action — agent 工具入口：投递动作并等待结果 */
router.post('/action', async (req: express.Request, res: express.Response) => {
  const { type, params } = req.body as { type?: string; params?: Record<string, unknown> };
  const valid: DeviceActionType[] = ['tap', 'swipe', 'screenshot', 'ui_dump', 'back', 'home', 'launch_app'];
  if (!type || !valid.includes(type as DeviceActionType)) {
    res.status(400).json({ error: `type must be one of: ${valid.join(', ')}` });
    return;
  }
  if (!deviceControlEnabled()) {
    res.status(409).json({ error: '设备控制未启用。请在 设置 → 设备控制 中启用，并在系统无障碍设置里开启 Synaps 服务。' });
    return;
  }
  const action = enqueueDeviceAction(type as DeviceActionType, params || {});
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      const done = getDeviceAction(action.id);
      if (done && done.status !== 'pending') {
        res.json({
          id: done.id,
          type: done.type,
          ok: done.status === 'done',
          result: done.result,
          error: done.error,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    res.status(504).json({ id: action.id, ok: false, error: '执行超时（20s）。请确认已在系统设置中开启 Synaps 无障碍服务。' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
