import 'dotenv/config';
import express from "express";
import cors from "cors";
import chatRouter from "./routes/chat.js";
import projectsRouter from "./routes/projects.js";
import filesRouter from "./routes/files.js";
import balanceRouter from "./routes/balance.js";
import exportRouter from "./routes/export.js";
import transcribeRouter from "./routes/transcribe.js";
import snapshotsRouter from "./routes/snapshots.js";
import githubRouter from "./routes/github.js";
import settingsRouter from "./routes/settings.js";
import terminalRouter from "./routes/terminal.js";

const app = express();
const port = process.env.PORT || 9091;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/v1/health', (req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

// Routes
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/projects', projectsRouter);
app.use('/api/v1/files', filesRouter);
app.use('/api/v1/balance', balanceRouter);
app.use('/api/v1/export', exportRouter);
app.use('/api/v1/transcribe', transcribeRouter);
app.use('/api/v1/snapshots', snapshotsRouter);
app.use('/api/v1/github', githubRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/terminal', terminalRouter);

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
});
