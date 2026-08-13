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

    init {
        System.loadLibrary("native-lib")
        System.loadLibrary("node")
    }

    private external fun startNodeWithArguments(arguments: Array<String>): Int

    @Volatile
    private var started = false

    fun start(context: Context) {
        if (started) return
        synchronized(this) {
            if (started) return
            started = true
            val appContext = context.applicationContext
            Executors.newSingleThreadExecutor().submit {
                try {
                    val nodeDir = File(appContext.filesDir, NODE_PROJECT_ASSET)
                    copyAssets(appContext.assets, NODE_PROJECT_ASSET, nodeDir)
                    saveLastUpdateTime(appContext)
                    val dataDir = File(nodeDir, "data")
                    if (!dataDir.exists()) dataDir.mkdirs()
                    Log.i(TAG, "Starting Node server from $nodeDir")
                    startNodeWithArguments(arrayOf("node", File(nodeDir, "main.cjs").absolutePath))
                } catch (t: Throwable) {
                    Log.e(TAG, "Node startup failed", t)
                }
            }
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

    private fun copyAssets(assetManager: AssetManager, fromAssetPath: String, toPath: File) {
        if (toPath.exists() && !wasApkUpdated()) return
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
