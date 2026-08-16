package com.aibox.app.node

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * 原生进程执行器
 *
 * nodejs-mobile 在 Android 上不支持 child_process.spawn/exec（会触发权限问题），
 * 这里由 Kotlin 用标准 ProcessBuilder 执行命令（Android 官方支持的进程启动方式）。
 *
 * 通信协议（与 server/src/nativeProc.ts 对齐）：
 * - 请求：<baseDir>/proc-req/<id>.json  { id, cmd, args[], env{}, cwd, timeoutMs }
 * - 输出：<baseDir>/proc-out/<id>.out / <id>.err / <id>.json（结果）
 * 其中 baseDir = filesDir/nodejs-project/data（与 SYNAPS_DATA_DIR 一致）
 */
object NativeProcRunner {
    private const val TAG = "SYNAPS_PROC"
    private const val REQ_DIR = "proc-req"
    private const val OUT_DIR = "proc-out"

    @Volatile
    private var started = false

    fun start(context: Context) {
        if (started) return
        synchronized(this) {
            if (started) return
            started = true
        }
        val baseDir = File(File(context.filesDir, "nodejs-project"), "data")
        val reqDir = File(baseDir, REQ_DIR)
        val outDir = File(baseDir, OUT_DIR)
        reqDir.mkdirs()
        outDir.mkdirs()
        val thread = Thread({ loop(reqDir, outDir) }, "synaps-proc-runner")
        thread.isDaemon = true
        thread.start()
        Log.i(TAG, "NativeProcRunner started: req=$reqDir out=$outDir")
    }

    private fun loop(reqDir: File, outDir: File) {
        while (true) {
            try {
                val files = reqDir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: emptyArray()
                for (f in files) {
                    val t = Thread({ runOne(f, outDir) }, "synaps-proc-${f.name}")
                    t.isDaemon = true
                    t.start()
                }
            } catch (t: Throwable) {
                Log.e(TAG, "poll error", t)
            }
            try {
                Thread.sleep(300)
            } catch (e: InterruptedException) {
                return
            }
        }
    }

    private fun runOne(reqFile: File, outDir: File) {
        val runningFile = File(reqFile.parentFile, reqFile.name + ".running")
        if (!reqFile.renameTo(runningFile)) return
        val id = reqFile.name.removeSuffix(".json")
        try {
            val req = JSONObject(runningFile.readText())
            val cmd = req.optString("cmd", "")
            val args = req.optJSONArray("args")?.let { arr ->
                (0 until arr.length()).map { arr.optString(it) }
            } ?: emptyList()
            val envMap = req.optJSONObject("env")?.let { obj ->
                obj.keys().asSequence().associateWith { obj.optString(it) }
            } ?: emptyMap()
            val cwd = req.optString("cwd", "")
            val timeoutMs = req.optLong("timeoutMs", 600000L)

            if (cmd.isBlank()) {
                writeResult(outDir, id, "cmd 为空")
                return
            }

            val outFile = File(outDir, "$id.out")
            val errFile = File(outDir, "$id.err")
            val pb = ProcessBuilder(listOf(cmd) + args)
            if (cwd.isNotBlank()) pb.directory(File(cwd))
            // stdin 重定向到 /dev/null：codex exec --json 等待 stdin EOF，否则会一直挂起
            pb.redirectInput(File("/dev/null"))
            pb.redirectOutput(outFile)
            pb.redirectError(errFile)
            if (envMap.isNotEmpty()) pb.environment().putAll(envMap)
            val proc = pb.start()

            var timedOut = false
            val deadline = System.currentTimeMillis() + timeoutMs
            while (true) {
                try {
                    proc.exitValue()
                    break
                } catch (e: IllegalThreadStateException) {
                    if (System.currentTimeMillis() >= deadline) {
                        timedOut = true
                        proc.destroyForcibly()
                        val killDeadline = System.currentTimeMillis() + 3000
                        while (true) {
                            try {
                                proc.exitValue()
                                break
                            } catch (e2: IllegalThreadStateException) {
                                if (System.currentTimeMillis() >= killDeadline) break
                                Thread.sleep(50)
                            }
                        }
                        break
                    }
                    Thread.sleep(100)
                }
            }

            var exitCode = -1
            try {
                exitCode = proc.exitValue()
            } catch (e: IllegalThreadStateException) {
                // 进程仍未退出（极少数情况），按失败处理
            }
            if (timedOut) exitCode = -1

            val result = JSONObject()
            result.put("id", id)
            result.put("exitCode", exitCode)
            result.put("timedOut", timedOut)
            result.put("outBytes", outFile.length())
            result.put("errBytes", errFile.length())
            File(outDir, "$id.json").writeText(result.toString())
        } catch (t: Throwable) {
            Log.e(TAG, "run failed for $id", t)
            writeResult(outDir, id, t.message ?: t.toString())
        } finally {
            runningFile.delete()
        }
    }

    private fun writeResult(outDir: File, id: String, error: String) {
        try {
            val result = JSONObject()
            result.put("id", id)
            result.put("error", error)
            File(outDir, "$id.json").writeText(result.toString())
        } catch (t: Throwable) {
            Log.e(TAG, "write result failed", t)
        }
    }
}
