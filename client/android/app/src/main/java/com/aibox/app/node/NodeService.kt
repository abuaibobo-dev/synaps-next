package com.aibox.app.node

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Runs the embedded Node server in its own process (":node") so a native
 * crash inside libnode.so never takes down the main app process.
 */
class NodeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NodeBridge.start(applicationContext)
    }
}
