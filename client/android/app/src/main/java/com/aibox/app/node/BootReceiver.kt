package com.aibox.app.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return
        try {
            context.startForegroundService(Intent(context, NodeService::class.java))
        } catch (t: Throwable) {
            android.util.Log.e("SYNAPS_NODE", "failed to start NodeService after boot", t)
        }
    }
}
