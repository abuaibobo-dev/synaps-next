package com.aibox.app.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Runs the embedded Node server in its own process (":node") so a native
 * crash inside libnode.so never takes down the main app process.
 *
 * Runs as a foreground service (specialUse): Android 16 blocks plain
 * background service starts ("Background start not allowed"), while FGS
 * starts are always permitted and specialUse has no time limit.
 */
class NodeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startAsForeground()
        NodeBridge.start(applicationContext)
    }

    private fun startAsForeground() {
        val channelId = "synaps_node"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(channelId, "Synaps 后端服务", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val builder: Notification.Builder =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, channelId)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
        val notification = builder
            .setContentTitle("Synaps")
            .setContentText("本地后端服务运行中")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, notification)
        }
    }
}
