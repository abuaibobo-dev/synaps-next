import 'dotenv/config';
import express from "express";
import cors from "cors";
import chatRouter, { startProactiveMonitor } from "./routes/chat.js";
import uploadsRouter from "./routes/uploads.js";
import projectsRouter from "./routes/projects.js";
import filesRouter from "./routes/files.js";
import balanceRouter from "./routes/balance.js";
import exportRouter from "./routes/export.js";
import transcribeRouter from "./routes/transcribe.js";
import snapshotsRouter from "./routes/snapshots.js";
import githubRouter from "./routes/github.js";
import settingsRouter from "./routes/settings.js";
import skillsRouter from "./routes/skills.js";
import skillStoreRouter from "./routes/skillStore.js";
import { runSkillStoreMaintenance } from "./skillStore.js";
import terminalRouter from "./routes/terminal.js";
import auditRouter from "./routes/audit.js";
import deviceRouter from "./routes/device.js";
import backupRouter from "./routes/backup.js";
import diagnosticsRouter from "./routes/diagnostics.js";
import tasksRouter from "./routes/tasks.js";
import brainsRouter from "./routes/brains.js";
import bridgeRouter from "./routes/bridge.js";
import codexLocalRouter from "./routes/codexLocal.js";
import ollamaRouter from "./routes/ollama.js";
import { seedImpeccableSkills } from "./impeccable.js";
import { seedDiagramSkill } from "./diagramSkill.js";
import { startAutonomousLoop } from "./autonomousLoop.js";

const app = express();
const port = process.env.PORT || 19091;

// Middleware
app.use(cors({
  origin(origin, callback) {
    if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return callback(null, true);
    callback(new Error('CORS origin denied'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/v1/health', (req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

// Routes
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/uploads', uploadsRouter);
app.use('/api/v1/projects', projectsRouter);
app.use('/api/v1/files', filesRouter);
app.use('/api/v1/balance', balanceRouter);
app.use('/api/v1/export', exportRouter);
app.use('/api/v1/transcribe', transcribeRouter);
app.use('/api/v1/snapshots', snapshotsRouter);
app.use('/api/v1/github', githubRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/skills', skillsRouter);
app.use('/api/v1/skill-store', skillStoreRouter);
app.use('/api/v1/terminal', terminalRouter);
app.use('/api/v1/audit', auditRouter);
app.use('/api/v1/device', deviceRouter);
app.use('/api/v1/backup', backupRouter);
app.use('/api/v1/diagnostics', diagnosticsRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/brains', brainsRouter);
app.use('/api/v1/bridge', bridgeRouter);
app.use('/api/v1/codex-local', codexLocalRouter);
app.use('/api/v1/ollama', ollamaRouter);

// 全局错误兜底：路由抛错时返回 JSON，而不是让内嵌 Node 进程崩溃
// （Express 4 不会捕获 async 路由里的异常，未捕获会导致整个后端断连）
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[route-error]', message);
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

// 进程级兜底：记录日志并保持服务存活，避免单次异常导致后端整体掉线
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.listen(Number(port), '127.0.0.1', () => {
  console.log(`Server listening at http://127.0.0.1:${port}/`);
  seedImpeccableSkills().catch(() => {});
  seedDiagramSkill();
  startProactiveMonitor();
  startAutonomousLoop().catch((error) => console.error('[autonomous-loop] startup failed:', error));
  // 技能商店后台维护：自动更新 + 测试通道转正/停用（启动 15s 后执行一次，之后每 24h 一次）
  setTimeout(() => {
    runSkillStoreMaintenance().catch((err) => console.error('[skill-store] maintenance failed:', err));
  }, 15000);
  setInterval(() => {
    runSkillStoreMaintenance().catch((err) => console.error('[skill-store] maintenance failed:', err));
  }, 24 * 3600 * 1000);
});
