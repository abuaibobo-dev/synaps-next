package com.aibox.app.node

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.Executors

object NodeBridge {
    private const val TAG = "SYNAPS_NODE"
    private const val NODE_PROJECT_ASSET = "nodejs-project"
    private const val PREFS_NAME = "SYNAPS_NODE_PREFS"
    private const val PREFS_LAST_UPDATE = "last_update_time"

    @Volatile
    private var loaded = false

    @Volatile
    private var started = false

    @Volatile
    private var lastError: String? = null

    @Volatile
    private var appContext: Context? = null

    val error: String? get() = lastError

    private external fun startNodeWithArguments(arguments: Array<String>): Int

    private fun ensureLoaded() {
        if (loaded) return
        System.loadLibrary("node")
        System.loadLibrary("native-lib")
        loaded = true
    }

    fun start(context: Context) {
        if (started) return
        synchronized(this) {
            if (started) return
            started = true
            val appContext = context.applicationContext
            this.appContext = appContext
            NativeProcRunner.start(appContext)
            Executors.newSingleThreadExecutor().submit {
                var attempt = 0
                while (true) {
                    attempt++
                    var startedAt = System.currentTimeMillis()
                    try {
                        log("Starting embedded Node... (attempt $attempt)")
                        ensureLoaded()
                        val nodeDir = File(appContext.filesDir, NODE_PROJECT_ASSET)
                        copyAssets(appContext, appContext.assets, NODE_PROJECT_ASSET, nodeDir)
                        saveLastUpdateTime(appContext)
                        val dataDir = File(nodeDir, "data")
                        if (!dataDir.exists()) dataDir.mkdirs()
                        val entry = File(nodeDir, "main.cjs")
                        if (!entry.exists()) {
                            val msg = "entry missing: ${entry.absolutePath}"
                            log(msg)
                            lastError = msg
                            continue
                        }
                        log("Launching: node ${entry.absolutePath}")
                        val code = startNodeWithArguments(arrayOf("node", entry.absolutePath))
                        lastError = "Node exited with code $code"
                        log("Node exited with code $code (attempt $attempt)")
                    } catch (t: Throwable) {
                        lastError = t.toString()
                        log("Node startup failed (attempt $attempt)", t)
                    }

                    // 长时间稳定运行后重置退避；异常退出则持续自动恢复。
                    if (System.currentTimeMillis() - startedAt > 5 * 60 * 1000L) attempt = 0
                    try {
                        Thread.sleep(if (attempt < 8) 2000L * attempt else 60000L)
                    } catch (e: InterruptedException) {
                        log("Node supervisor interrupted")
                        break
                    }
                }
            }
        }
    }

    private fun log(msg: String, t: Throwable? = null) {
        Log.e(TAG, msg, t)
        try {
            val dir = appContext?.filesDir ?: return
            val f = File(dir, "node-bridge.log")
            val line = "${System.currentTimeMillis()} $msg" + (t?.let { " | ${it.javaClass.simpleName}: ${it.message}" } ?: "") + "\n"
            f.appendText(line)
        } catch (_: Throwable) {
        }
    }

    private fun wasApkUpdated(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val previous = prefs.getLong(PREFS_LAST_UPDATE, 0)
        val lastUpdate = try {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            0L
        }
        return lastUpdate != previous
    }

    private fun saveLastUpdateTime(context: Context) {
        val lastUpdate = try {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            return
        }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putLong(PREFS_LAST_UPDATE, lastUpdate).apply()
    }

    private fun copyAssets(context: Context, assetManager: AssetManager, fromAssetPath: String, toPath: File) {
        if (toPath.exists() && !wasApkUpdated(context)) return
        deleteRecursively(toPath)
        copyAssetFolder(assetManager, fromAssetPath, toPath)
    }

    private fun copyAssetFolder(assetManager: AssetManager, fromAssetPath: String, toPath: File) {
        try {
            val files = assetManager.list(fromAssetPath) ?: return
            if (files.isEmpty()) {
                copyAsset(assetManager, fromAssetPath, toPath)
                return
            }
            toPath.mkdirs()
            for (file in files) {
                copyAssetFolder(assetManager, "$fromAssetPath/$file", File(toPath, file))
            }
        } catch (e: IOException) {
            Log.e(TAG, "copyAssetFolder failed: $fromAssetPath", e)
        }
    }

    private fun copyAsset(assetManager: AssetManager, fromAssetPath: String, toPath: File) {
        try {
            val input: InputStream = assetManager.open(fromAssetPath)
            toPath.parentFile?.mkdirs()
            toPath.createNewFile()
            FileOutputStream(toPath).use { out -> input.copyTo(out) }
            input.close()
        } catch (e: IOException) {
            Log.e(TAG, "copyAsset failed: $fromAssetPath", e)
        }
    }

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        file.delete()
    }
}
