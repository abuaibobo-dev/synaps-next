package com.aibox.app.device

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File
import java.io.FileOutputStream

/**
 * 无障碍服务：让 Synaps 的 Agent 能读取屏幕内容并模拟点击/滑动/截图。
 * 用户需在 系统设置 → 无障碍 → Synaps 设备控制 中手动开启。
 */
class DeviceAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "SYNAPS_DEVICE"
        @Volatile
        var instance: DeviceAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 主动查询模式：不需要处理事件流
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    fun performTap(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 60)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun performSwipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun globalNav(action: Int): Boolean = performGlobalAction(action)

    /** 导出可见 UI 树（含文本/描述/可点击/屏幕坐标），供 Agent 理解当前界面 */
    fun uiDump(maxLen: Int = 30000): String {
        val root = rootInActiveWindow ?: return "(no active window)"
        val sb = StringBuilder()
        dumpNode(root, 0, sb, maxLen)
        return sb.toString().ifEmpty { "(empty ui tree)" }
    }

    private fun dumpNode(node: AccessibilityNodeInfo, depth: Int, sb: StringBuilder, maxLen: Int) {
        if (sb.length >= maxLen || depth > 40) return
        val className = node.className?.toString()?.substringAfterLast('.') ?: "?"
        val text = node.text?.toString()?.take(80) ?: ""
        val desc = node.contentDescription?.toString()?.take(80) ?: ""
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        val clickable = node.isClickable
        if (text.isNotEmpty() || desc.isNotEmpty() || clickable || depth <= 1) {
            val indent = "  ".repeat(depth)
            sb.append("$indent<$className")
            if (text.isNotEmpty()) sb.append(" text=\"$text\"")
            if (desc.isNotEmpty()) sb.append(" desc=\"$desc\"")
            if (clickable) sb.append(" clickable")
            sb.append(" bounds=[${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}]/>\n")
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            dumpNode(child, depth + 1, sb, maxLen)
        }
    }

    /** 截取当前屏幕（API 30+，无障碍截图可捕获任意应用的界面） */
    fun takeScreenshot(onResult: (path: String?, width: Int, height: Int, error: Int) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            onResult(null, 0, 0, -1)
            return
        }
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(screenshot: ScreenshotResult) {
                val buffer = screenshot.hardwareBuffer
                try {
                    val bitmap = Bitmap.wrapHardwareBuffer(buffer, ColorSpace.get(ColorSpace.Named.SRGB))
                    if (bitmap == null) {
                        onResult(null, 0, 0, -2)
                        return
                    }
                    val dir = File(filesDir, "synaps_device").apply { mkdirs() }
                    val file = File(dir, "screenshot_${System.currentTimeMillis()}.png")
                    FileOutputStream(file).use { out ->
                        bitmap.compress(Bitmap.CompressFormat.PNG, 90, out)
                    }
                    val w = bitmap.width
                    val h = bitmap.height
                    onResult(file.absolutePath, w, h, 0)
                } catch (t: Throwable) {
                    Log.e(TAG, "screenshot failed", t)
                    onResult(null, 0, 0, -3)
                } finally {
                    buffer.close()
                }
            }

            override fun onFailure(errorCode: Int) {
                Log.e(TAG, "screenshot failure code=$errorCode")
                onResult(null, 0, 0, errorCode)
            }
        })
    }
}
